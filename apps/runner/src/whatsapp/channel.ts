/**
 * WhatsApp ligado por QR code no computador da pessoa, para falar com o próprio agente.
 *
 * O desenho e as regras de segurança seguem o Nod (n8n-io/nod, `src/providers/chat-sdk/whatsapp.ts`,
 * Apache-2.0):
 *  - dois modos: "self-chat" (a pessoa vincula o próprio número e usa a conversa "Mensagem para você
 *    mesmo") e "bot" (vincula um número separado, que só aceita mensagens do número pessoal dela);
 *  - grupos, status, canais e histórico são ignorados; nada anterior ao vínculo é lido;
 *  - o agente só escreve para a própria pessoa, nunca para outro contato;
 *  - um envio com resultado incerto não é repetido;
 *  - "desconectado pelo celular" apaga as chaves; outros erros graves param sem apagar.
 *
 * É um cliente não oficial (biblioteca Baileys): serve para uso pessoal, com poucas mensagens. Para
 * atender clientes ou disparar mensagens, o caminho é a API oficial, configurada no hub.
 */
import type { Logger } from "../log.js";
import type { SlotStore } from "./store.js";

export type WaMode = "self-chat" | "bot";
export type WaState = "stopped" | "connecting" | "awaiting_scan" | "connected" | "logged_out" | "failed" | "expired";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface WaSocket {
  ev: { on(event: string, listener: (arg: any) => void): void };
  user?: { id?: string; lid?: string };
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null>; getLIDForPN(pn: string): Promise<string | null> } };
  sendMessage(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ key?: { id?: string | null } } | undefined>;
  sendPresenceUpdate(type: string, jid: string): Promise<void>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

/** A parte da biblioteca Baileys que o canal usa. */
export interface WaLib {
  makeWASocket(config: Record<string, unknown>): WaSocket;
  BufferJSON: { replacer(key: string, value: any): any; reviver(key: string, value: any): any };
  initAuthCreds(): any;
  DisconnectReason: Record<string, number | string>;
  jidNormalizedUser(jid?: string): string;
  normalizeMessageContent(message: unknown): any;
  generateMessageIDV2(userId?: string): string;
  proto: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type WaDropReason =
  | "unsupported_chat"
  | "sender_unmatched"
  | "self_chat_mismatch"
  | "from_me"
  | "before_link"
  | "invalid_time"
  | "own_echo"
  | "missing_id"
  | "lid_lookup_failed"
  | "decrypt_failed"
  | "unsupported_type"
  | "resend_ignored"
  | "queue_full";

export interface WhatsAppOptions {
  lib: WaLib;
  store: SlotStore;
  mode: WaMode;
  /** Modo "bot": o número pessoal da dona (só dígitos, com código do país). */
  allowedNumber?: string;
  /** `true` no comando de vínculo: aceita começar sem chaves e mostra o QR. O runner em execução usa `false`. */
  pairing?: boolean;
  onText(text: string): void;
  onQr?(qr: string, expiresAt: number): void;
  onState?(state: WaState, detail: string): void;
  onDrop?(reason: WaDropReason): void;
  /** Cada queda de conexão, com o código do WhatsApp e a mensagem da biblioteca (sem dados da conta). */
  onDisconnect?(code: number | undefined, message: string, attempt: number): void;
  logger: Logger;
  /** Testes: base da espera para reconectar (padrão 1000 ms) e prazo do vínculo (padrão 5 min). */
  reconnectBaseMs?: number;
  setupTimeoutMs?: number;
}

const QR_LIFETIME_MS = 60_000;
const MAX_QUEUE = 1000;
const MAX_SENT_IDS = 2000;
const MAX_TEXT = 3800;
const MAX_PARTS = 8;
const CIPHERTEXT_STUB = 2; // proto.WebMessageInfo.StubType.CIPHERTEXT

const silentLogger = {
  level: "silent",
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function validPhone(n: string | undefined): n is string {
  return !!n && /^\d{7,15}$/.test(n);
}

/** Parte um texto longo em mensagens, quebrando em parágrafo ou linha quando dá. */
export function splitText(text: string, max = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export class WhatsAppChannel {
  state: WaState = "stopped";
  detail = "";

  private socket: WaSocket | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private creds: any = null;
  private writes: Promise<void> = Promise.resolve();
  /** Apagar as chaves leva um instante; quem encerra o canal espera isso terminar. */
  private cleanup: Promise<void> = Promise.resolve();
  private work: Promise<void> = Promise.resolve();
  private queued = 0;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private setupTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private sentIds = new Set<string>();
  private linkedAt: number | null = null;
  /** Conversa por onde a dona escreveu por último (pode ser um endereço @lid): a resposta volta por ela. */
  private replyJid: string | null = null;
  private allowedLid: string | null = null;
  private revokedLids = new Set<string>();
  private lastNotice = 0;

  constructor(private readonly o: WhatsAppOptions) {
    if (o.mode === "bot" && !validPhone(o.allowedNumber)) throw new Error("no modo de número separado, informe o seu número pessoal (só dígitos, com código do país)");
  }

  // ---------- Estado ----------
  private setState(state: WaState, detail = ""): void {
    this.state = state;
    this.detail = detail;
    this.o.onState?.(state, detail);
  }

  private numberOf(jid: string | null | undefined): string | undefined {
    const normalized = jid ? this.o.lib.jidNormalizedUser(jid) : "";
    return /^\d{7,15}@s\.whatsapp\.net$/.test(normalized) ? normalized.split("@")[0] : undefined;
  }

  /** O número vinculado (o do aparelho que leu o QR). */
  ownNumber(): string | undefined {
    return this.numberOf(this.creds?.me?.id ?? this.socket?.user?.id);
  }

  private ownLid(): string | undefined {
    const lid = this.creds?.me?.lid ?? this.socket?.user?.lid;
    return lid ? this.o.lib.jidNormalizedUser(lid) : undefined;
  }

  linked(): boolean {
    return !!this.creds?.me?.id;
  }

  /** Quem pode escrever para o agente: no modo próprio, a própria conta; no modo separado, o número pessoal. */
  private allowedSender(): string | undefined {
    return this.o.mode === "self-chat" ? this.ownNumber() : this.o.allowedNumber;
  }

  private drop(reason: WaDropReason): void {
    this.o.onDrop?.(reason);
  }

  // ---------- Chaves ----------
  private save(entries: Record<string, string | null>): Promise<void> {
    const next = this.writes.then(() => this.o.store.set(entries));
    this.writes = next.catch(() => {});
    return next.catch((e: unknown) => {
      // Sem conseguir gravar as chaves, continuar corromperia o vínculo.
      this.halt("failed", "Não consegui gravar as chaves do WhatsApp neste computador.");
      throw e;
    });
  }

  private saveCreds(): Promise<void> {
    return this.save({ creds: JSON.stringify(this.creds, this.o.lib.BufferJSON.replacer) });
  }

  private authState() {
    const { lib, store } = this.o;
    return {
      creds: this.creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
          for (const id of ids) {
            const raw = await store.get(`${type}:${id}`);
            if (raw === undefined) continue;
            let value: unknown = JSON.parse(raw, lib.BufferJSON.reviver);
            if (type === "app-state-sync-key" && value) value = lib.proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown> | undefined>) => {
          const values: Record<string, string | null> = {};
          for (const [type, items] of Object.entries(data)) {
            for (const [id, value] of Object.entries(items ?? {})) values[`${type}:${id}`] = value == null ? null : JSON.stringify(value, lib.BufferJSON.replacer);
          }
          await this.save(values);
        },
      },
    };
  }

  // ---------- Ligar e desligar ----------
  async start(): Promise<void> {
    const { lib, store } = this.o;
    const raw = await store.get("creds");
    if (!raw && !this.o.pairing) {
      this.setState("stopped", "O WhatsApp não está vinculado neste computador. Rode `puxibot whatsapp conectar`.");
      return;
    }
    this.creds = raw ? JSON.parse(raw, lib.BufferJSON.reviver) : lib.initAuthCreds();
    try {
      const ids = JSON.parse((await store.get("sent-ids")) ?? "[]") as unknown;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.sentIds.add(id);
    } catch {
      /* lista ilegível: começa vazia */
    }
    const started = Number(await store.get("intake-start"));
    this.linkedAt = Number.isFinite(started) && started > 0 ? started : null;
    this.replyJid = (await store.get("reply-jid")) ?? null;
    this.stopped = false;
    if (!raw) await this.saveCreds();
    if (!this.linked()) {
      // Vínculo novo: o QR vale 1 minuto e a montagem inteira, 5. Depois disso as chaves pela metade somem.
      this.setupTimer = setTimeout(() => {
        this.cleanup = this.o.store.clear().catch(() => {});
        this.halt("expired", "O tempo para ler o QR code acabou. Comece de novo para receber outro.");
      }, this.o.setupTimeoutMs ?? 5 * 60_000);
      this.setupTimer.unref();
    }
    this.connect();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.reconnectTimer = null;
    this.setupTimer = null;
  }

  /** Para de vez, com um estado final. As chaves ficam (quem apaga é o chamador, quando for o caso). */
  private halt(state: WaState, detail: string): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.end(undefined);
    } catch {
      /* já fechado */
    }
    this.setState(state, detail);
  }

  /** Desliga a conexão e mantém o vínculo (o runner está encerrando). */
  async stop(): Promise<void> {
    this.halt("stopped", "");
    await this.writes;
    await this.cleanup;
  }

  /** Desvincula: avisa o WhatsApp (o aparelho some de "Dispositivos conectados") e apaga as chaves daqui. */
  async unlink(): Promise<void> {
    const socket = this.socket;
    if (socket && this.state === "connected") {
      await Promise.race([socket.logout().catch(() => {}), new Promise<void>((r) => setTimeout(r, 5000).unref())]);
    }
    this.halt("stopped", "");
    await this.writes;
    await this.o.store.clear();
    this.creds = null;
    this.sentIds.clear();
    this.replyJid = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const { lib } = this.o;
    this.setState("connecting");
    const socket = lib.makeWASocket({
      auth: this.authState(),
      logger: silentLogger,
      browser: ["Puxibot", "Chrome", "1.0"],
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      maxMsgRetryCount: 0,
      enableAutoSessionRecreation: false,
      enableRecentMessageCache: false,
      getMessage: async () => undefined,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 30_000,
      qrTimeout: QR_LIFETIME_MS,
      // Grupos, status e canais nem chegam a ser decifrados; de contatos, só o número permitido.
      shouldIgnoreJid: (jid: string) => {
        if (jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) return true;
        const phone = this.numberOf(jid);
        return Boolean(phone && phone !== this.allowedSender() && phone !== this.ownNumber());
      },
    });
    this.socket = socket;
    const current = () => this.socket === socket && !this.stopped;

    socket.ev.on("creds.update", (update: Record<string, unknown>) => {
      if (!current()) return;
      Object.assign(this.creds, update);
      void this.saveCreds().catch(() => {});
    });

    if (this.o.mode === "bot") {
      socket.ev.on("lid-mapping.update", (m: { lid?: string; pn?: string }) => {
        if (!current() || !m?.lid) return;
        const lid = lib.jidNormalizedUser(m.lid);
        if (this.numberOf(m.pn) === this.o.allowedNumber) {
          this.allowedLid = lid;
          this.revokedLids.delete(lid);
        } else {
          this.revokedLids.add(lid);
          if (this.allowedLid === lid) this.allowedLid = null;
        }
      });
    }

    socket.ev.on("messages.upsert", (event: { messages?: unknown[]; requestId?: string }) => {
      if (!current()) return;
      // Reenvio pedido por outro aparelho (histórico): não é mensagem nova.
      if (event.requestId) return this.drop("resend_ignored");
      for (const message of event.messages ?? []) {
        if (this.queued >= MAX_QUEUE) {
          this.drop("queue_full");
          continue;
        }
        this.queued += 1;
        this.work = this.work
          .then(() => (current() ? this.intake(socket, message as WaMessage) : undefined))
          .catch((e: unknown) => this.o.logger.warn(`whatsapp: mensagem ignorada por erro (${e instanceof Error ? e.message : String(e)})`))
          .finally(() => {
            this.queued -= 1;
          });
      }
    });

    socket.ev.on("connection.update", (update: { qr?: string; isNewLogin?: boolean; connection?: string; lastDisconnect?: { error?: { message?: string; output?: { statusCode?: number } } } }) => {
      if (!current()) return;
      if (update.qr) {
        if (!this.o.pairing) return this.halt("stopped", "O WhatsApp pediu um QR code novo. Rode `puxibot whatsapp conectar`.");
        this.setState("awaiting_scan");
        this.o.onQr?.(update.qr, Date.now() + QR_LIFETIME_MS);
      }
      if (update.isNewLogin) this.setState("connecting");
      if (update.connection === "open") void this.onOpen();
      if (update.connection === "close") {
        const error = update.lastDisconnect?.error;
        this.o.onDisconnect?.(error?.output?.statusCode, String(error?.message ?? "").slice(0, 200), this.attempt + 1);
        if (current()) this.onClose(error?.output?.statusCode);
      }
    });
  }

  private async onOpen(): Promise<void> {
    this.attempt = 0;
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = null;
    const own = this.ownNumber();
    if (this.o.mode === "bot" && own && own === this.o.allowedNumber) {
      // No modo de número separado, o aparelho vinculado não pode ser o próprio número pessoal.
      await this.unlink().catch(() => {});
      this.setState("failed", "O número vinculado é o seu número pessoal. Use o modo de número próprio, ou vincule o outro número.");
      return;
    }
    if (this.linkedAt === null) {
      // Só entra o que chegar depois do vínculo: nada do histórico vira pedido.
      this.linkedAt = Date.now() - 2000;
      await this.save({ "intake-start": String(this.linkedAt) }).catch(() => {});
    }
    this.setState("connected");
  }

  private onClose(code: number | undefined): void {
    const R = this.o.lib.DisconnectReason;
    this.socket = null;
    if (code === R.loggedOut) {
      this.cleanup = this.writes.then(() => this.o.store.clear()).catch(() => {});
      this.halt("logged_out", "O WhatsApp foi desconectado pelo celular. Rode `puxibot whatsapp conectar` para vincular de novo.");
      return;
    }
    if (code === R.connectionReplaced || code === R.badSession || code === R.forbidden || code === R.multideviceMismatch) {
      const why =
        code === R.connectionReplaced ? "outra conexão assumiu este vínculo (há outro runner com o mesmo WhatsApp?)" : code === R.forbidden ? "o WhatsApp recusou a conta" : "a sessão ficou inválida";
      return this.halt("failed", `O WhatsApp parou: ${why}. Reinicie o runner; se continuar, desconecte e vincule de novo.`);
    }
    if (this.stopped) return;
    const wait = Math.min(60_000, (this.o.reconnectBaseMs ?? 1000) * 2 ** Math.min(this.attempt, 6));
    this.attempt += 1;
    this.setState("connecting");
    // Sem `unref`: logo depois de ler o QR o WhatsApp fecha a conexão e pede para reconectar. No comando
    // de vínculo essa espera é a única coisa pendente, e o processo terminaria antes de concluir.
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  // ---------- Entrada ----------
  /** Devolve o número de quem escreveu, só se for a dona na conversa certa; senão registra o motivo e devolve null. */
  private async sender(socket: WaSocket, key: WaKey): Promise<string | null> {
    const { lib, mode } = this.o;
    const jid = key.remoteJid ?? "";
    if (!jid || key.participant || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid)) {
      this.drop("unsupported_chat");
      return null;
    }
    const normalized = lib.jidNormalizedUser(jid);
    if (this.revokedLids.has(normalized)) {
      this.drop("sender_unmatched");
      return null;
    }
    let phone: string | undefined;
    if (!normalized.endsWith("@lid")) phone = this.numberOf(normalized);
    else if (mode === "self-chat") phone = normalized === this.ownLid() ? this.ownNumber() : undefined;
    else {
      phone = this.numberOf(key.remoteJidAlt);
      const mapping = socket.signalRepository?.lidMapping;
      if (!phone && mapping) phone = this.numberOf(await mapping.getPNForLID(normalized).catch(() => null));
      if (!phone) {
        let lid: string | null = null;
        if (mapping) {
          try {
            lid = await mapping.getLIDForPN(`${this.o.allowedNumber}@s.whatsapp.net`);
          } catch {
            this.drop("lid_lookup_failed");
            return null;
          }
        }
        const known = lid ? lib.jidNormalizedUser(lid) : this.allowedLid;
        if (known && known === normalized) phone = this.o.allowedNumber;
      }
    }
    if (mode === "self-chat") {
      if (!phone || phone !== this.ownNumber() || !key.fromMe) {
        this.drop("self_chat_mismatch");
        return null;
      }
      return phone;
    }
    if (!phone || phone !== this.o.allowedNumber) {
      this.drop("sender_unmatched");
      return null;
    }
    if (key.fromMe) {
      this.drop("from_me");
      return null;
    }
    return phone;
  }

  private async intake(socket: WaSocket, message: WaMessage): Promise<void> {
    const key = message?.key ?? {};
    if (!key.id) return this.drop("missing_id");
    if (this.sentIds.has(key.id)) return this.drop("own_echo");
    const ts = message.messageTimestamp;
    // O horário pode vir como número ou como inteiro longo (objeto).
    const at = Number(typeof ts === "object" && ts ? ts.toString() : ts) * 1000;
    if (!Number.isFinite(at) || at > Date.now() + 5 * 60_000) return this.drop("invalid_time");
    if (this.linkedAt === null || at < this.linkedAt) return this.drop("before_link");
    if (!(await this.sender(socket, key))) return;
    if (this.revokedLids.has(this.o.lib.jidNormalizedUser(key.remoteJid ?? ""))) return this.drop("sender_unmatched");
    const content = this.o.lib.normalizeMessageContent(message.message) as Record<string, { text?: string; caption?: string } | string | undefined> | undefined;
    if (!content || Object.keys(content).length === 0) return this.drop(message.messageStubType === CIPHERTEXT_STUB ? "decrypt_failed" : "unsupported_type");
    if (content.reactionMessage || content.protocolMessage) return;
    const jid = key.remoteJid!;
    if (jid !== this.replyJid) {
      this.replyJid = jid;
      await this.save({ "reply-jid": jid }).catch(() => {});
    }
    const text = (typeof content.conversation === "string" ? content.conversation : undefined) ?? (content.extendedTextMessage as { text?: string } | undefined)?.text ?? "";
    if (!text.trim()) {
      this.drop("unsupported_type");
      // Áudio, foto ou arquivo: por enquanto só texto. Avisa no máximo uma vez por minuto.
      if (Date.now() - this.lastNotice > 60_000) {
        this.lastNotice = Date.now();
        await this.sendText("Por enquanto só consigo ler texto por aqui. Escreva o que você precisa.").catch(() => {});
      }
      return;
    }
    void socket.sendPresenceUpdate("composing", jid).catch(() => {});
    this.o.onText(text);
  }

  // ---------- Saída ----------
  /** A resposta só vai para a própria dona: a conversa por onde ela escreveu, ou o número dela. */
  private target(): string | null {
    const own = this.ownNumber();
    if (!own) return null;
    if (this.o.mode === "self-chat") {
      if (this.replyJid && (this.replyJid === this.ownLid() || this.numberOf(this.replyJid) === own)) return this.replyJid;
      return `${own}@s.whatsapp.net`;
    }
    if (this.replyJid && /^\d+@(s\.whatsapp\.net|lid)$/.test(this.replyJid)) {
      const phone = this.numberOf(this.replyJid);
      if (phone === this.o.allowedNumber || (this.replyJid.endsWith("@lid") && !this.revokedLids.has(this.replyJid))) return this.replyJid;
    }
    return `${this.o.allowedNumber}@s.whatsapp.net`;
  }

  async sendText(text: string): Promise<void> {
    const socket = this.socket;
    const jid = this.target();
    if (!socket || this.state !== "connected" || !jid) throw new Error("o WhatsApp não está conectado");
    for (const part of splitText(text).slice(0, MAX_PARTS)) {
      const id = this.o.lib.generateMessageIDV2(this.creds?.me?.id);
      this.sentIds.add(id);
      while (this.sentIds.size > MAX_SENT_IDS) this.sentIds.delete(this.sentIds.values().next().value as string);
      // Gravado antes de enviar: o eco da própria mensagem não vira pedido nem depois de reiniciar.
      await this.save({ "sent-ids": JSON.stringify([...this.sentIds]) });
      const result = await socket.sendMessage(jid, { text: part, linkPreview: null }, { messageId: id });
      // Sem confirmação, não repete: um envio duvidoso repetido vira mensagem duplicada.
      if (!result?.key?.id || result.key.id !== id) throw new Error("o WhatsApp não confirmou o envio");
    }
  }
}

interface WaKey {
  id?: string | null;
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  fromMe?: boolean | null;
}
interface WaMessage {
  key?: WaKey;
  message?: unknown;
  messageTimestamp?: number | string | { toString(): string } | null;
  messageStubType?: number | null;
}
