import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerToHub } from "@puxibot/shared";
import { silentLogger } from "../src/log.js";
import { startWhatsAppBridge } from "../src/whatsapp/bridge.js";
import { splitText, WhatsAppChannel, type WaDropReason, type WaLib, type WaMode, type WaSocket, type WaState } from "../src/whatsapp/channel.js";
import { fileSlotStore, memorySlotStore } from "../src/whatsapp/store.js";

const OWN = "5511999990000";
const OTHER = "5511888880000";
const pn = (n: string) => `${n}@s.whatsapp.net`;

class FakeSocket implements WaSocket {
  ev = new EventEmitter();
  user?: { id?: string; lid?: string };
  signalRepository = { lidMapping: { getPNForLID: async (_lid: string): Promise<string | null> => null, getLIDForPN: async (_pn: string): Promise<string | null> => null } };
  sent: { jid: string; content: Record<string, unknown>; id: string }[] = [];
  presence: string[] = [];
  ended = false;
  loggedOut = false;
  confirm = true;
  constructor(public config: Record<string, unknown>) {}
  async sendMessage(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) {
    const id = String(options?.messageId);
    this.sent.push({ jid, content, id });
    return this.confirm ? { key: { id } } : undefined;
  }
  async sendPresenceUpdate(type: string, jid: string) {
    this.presence.push(`${type}:${jid}`);
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
}

function fake() {
  const sockets: FakeSocket[] = [];
  let n = 0;
  const lib: WaLib = {
    makeWASocket: (config) => {
      const s = new FakeSocket(config);
      sockets.push(s);
      return s;
    },
    BufferJSON: { replacer: (_k, v) => v, reviver: (_k, v) => v },
    initAuthCreds: () => ({ registered: false }),
    DisconnectReason: { loggedOut: 401, forbidden: 403, multideviceMismatch: 411, connectionReplaced: 440, badSession: 500, restartRequired: 515 },
    jidNormalizedUser: (jid) => (jid ?? "").replace(/:\d+@/, "@"),
    normalizeMessageContent: (m) => m,
    generateMessageIDV2: () => `OUT${(n += 1)}`,
    proto: { Message: { AppStateSyncKeyData: { fromObject: (v: unknown) => v } } },
  };
  return { lib, sockets };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
let seq = 0;
const msg = (remoteJid: string, text: string, extra: Record<string, unknown> = {}, key: Record<string, unknown> = {}) => ({
  key: { id: `IN${(seq += 1)}`, remoteJid, fromMe: false, ...key },
  messageTimestamp: Math.floor(Date.now() / 1000) + 1,
  message: { conversation: text },
  ...extra,
});

async function linked(mode: WaMode, opts: { allowedNumber?: string; ownId?: string } = {}) {
  const { lib, sockets } = fake();
  const store = memorySlotStore();
  await store.set({ creds: JSON.stringify({ me: { id: `${opts.ownId ?? OWN}:7@s.whatsapp.net`, lid: "99887766:7@lid" } }) });
  const texts: string[] = [];
  const drops: WaDropReason[] = [];
  const states: WaState[] = [];
  const channel = new WhatsAppChannel({
    lib,
    store,
    mode,
    allowedNumber: opts.allowedNumber,
    logger: silentLogger,
    reconnectBaseMs: 1,
    onText: (t) => texts.push(t),
    onDrop: (r) => drops.push(r),
    onState: (s) => states.push(s),
  });
  await channel.start();
  sockets[0]!.ev.emit("connection.update", { connection: "open" });
  await tick();
  const upsert = async (...messages: unknown[]) => {
    sockets.at(-1)!.ev.emit("messages.upsert", { messages, type: "notify" });
    await tick();
  };
  return { channel, lib, sockets, store, texts, drops, states, upsert };
}

describe("WhatsApp por QR code: vínculo", () => {
  it("mostra o QR, guarda as chaves e só aceita mensagens posteriores ao vínculo", async () => {
    const { lib, sockets } = fake();
    const store = memorySlotStore();
    const qrs: string[] = [];
    const states: WaState[] = [];
    const channel = new WhatsAppChannel({ lib, store, mode: "self-chat", pairing: true, logger: silentLogger, onText: () => {}, onQr: (q) => qrs.push(q), onState: (s) => states.push(s) });
    await channel.start();
    expect(store.data.has("creds")).toBe(true);
    const s = sockets[0]!;
    // Mesmas proteções do Nod: sem histórico, sem reenvio automático, sem marcar como online.
    expect(s.config).toMatchObject({ syncFullHistory: false, markOnlineOnConnect: false, maxMsgRetryCount: 0, emitOwnEvents: false });
    expect((s.config.shouldSyncHistoryMessage as () => boolean)()).toBe(false);
    const ignore = s.config.shouldIgnoreJid as (jid: string) => boolean;
    expect(ignore("123@g.us")).toBe(true);
    expect(ignore("status@broadcast")).toBe(true);
    s.ev.emit("connection.update", { qr: "QR-1" });
    expect(qrs).toEqual(["QR-1"]);
    expect(channel.state).toBe("awaiting_scan");
    s.ev.emit("creds.update", { me: { id: `${OWN}:7@s.whatsapp.net`, lid: "99887766:7@lid" } });
    s.ev.emit("connection.update", { isNewLogin: true });
    s.ev.emit("connection.update", { connection: "open" });
    await tick();
    expect(channel.state).toBe("connected");
    expect(channel.ownNumber()).toBe(OWN);
    expect(JSON.parse(store.data.get("creds")!).me.id).toContain(OWN);
    expect(Number(store.data.get("intake-start"))).toBeGreaterThan(Date.now() - 10_000);
    expect(ignore(pn(OTHER))).toBe(true);
    expect(ignore(pn(OWN))).toBe(false);
    await channel.stop();
    expect(s.ended).toBe(true);
    expect(store.data.has("creds")).toBe(true);
  });

  it("sem chaves, o runner em execução não abre conexão nem mostra QR; um QR pedido no meio do caminho para tudo", async () => {
    const a = fake();
    const idle = new WhatsAppChannel({ lib: a.lib, store: memorySlotStore(), mode: "self-chat", logger: silentLogger, onText: () => {} });
    await idle.start();
    expect(a.sockets).toHaveLength(0);
    expect(idle.detail).toMatch(/puxibot whatsapp conectar/);

    const b = await linked("self-chat");
    b.sockets[0]!.ev.emit("connection.update", { qr: "QR-X" });
    expect(b.channel.state).toBe("stopped");
    expect(b.sockets[0]!.ended).toBe(true);
  });

  it("o prazo do vínculo vence e as chaves pela metade são apagadas", async () => {
    const { lib } = fake();
    const store = memorySlotStore();
    const channel = new WhatsAppChannel({ lib, store, mode: "self-chat", pairing: true, logger: silentLogger, onText: () => {}, setupTimeoutMs: 10 });
    await channel.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(channel.state).toBe("expired");
    expect(store.data.size).toBe(0);
  });

  it("no modo de número separado, vincular o próprio número pessoal é recusado e desfeito", async () => {
    const t = await linked("bot", { allowedNumber: OWN });
    expect(t.channel.state).toBe("failed");
    expect(t.store.data.size).toBe(0);
    expect(() => new WhatsAppChannel({ lib: t.lib, store: t.store, mode: "bot", logger: silentLogger, onText: () => {} })).toThrow(/número pessoal/);
  });
});

describe("WhatsApp por QR code: quem pode escrever", () => {
  it("número próprio: só a conversa com você mesmo vira pedido", async () => {
    const t = await linked("self-chat");
    await t.upsert(msg(pn(OWN), "oi agente", {}, { fromMe: true }));
    await t.upsert(msg("99887766@lid", "pelo endereço novo", {}, { fromMe: true }));
    expect(t.texts).toEqual(["oi agente", "pelo endereço novo"]);
    expect(t.sockets[0]!.presence).toContain(`composing:${pn(OWN)}`);
    t.drops.length = 0;
    await t.upsert(
      msg(pn(OTHER), "sou outra pessoa"),
      msg(pn(OTHER), "você escreveu para outra pessoa", {}, { fromMe: true }),
      msg("5511777@g.us", "grupo", {}, { participant: pn(OTHER) }),
      msg("12345@lid", "lid de outra pessoa", {}, { fromMe: true }),
      msg(pn(OWN), "antiga", { messageTimestamp: 1_000_000 }, { fromMe: true }),
      msg(pn(OWN), "do futuro", { messageTimestamp: Math.floor(Date.now() / 1000) + 3600 }, { fromMe: true }),
      msg(pn(OWN), "sem id", {}, { fromMe: true, id: null }),
    );
    expect(t.texts).toHaveLength(2);
    expect(t.drops).toEqual(["self_chat_mismatch", "self_chat_mismatch", "unsupported_chat", "self_chat_mismatch", "before_link", "invalid_time", "missing_id"]);
    // Reenvio de histórico pedido por outro aparelho não entra.
    t.sockets[0]!.ev.emit("messages.upsert", { messages: [msg(pn(OWN), "reenvio", {}, { fromMe: true })], requestId: "r1" });
    await tick();
    expect(t.texts).toHaveLength(2);
  });

  it("número separado: só o número pessoal da dona; os endereços @lid são conferidos", async () => {
    const t = await linked("bot", { allowedNumber: OTHER, ownId: OWN });
    await t.upsert(msg(pn(OTHER), "oi"));
    expect(t.texts).toEqual(["oi"]);
    await t.upsert(msg(pn("5511666660000"), "estranho"), msg(pn(OTHER), "eco", {}, { fromMe: true }));
    expect(t.drops.slice(-2)).toEqual(["sender_unmatched", "from_me"]);
    // @lid desconhecido: recusado. Com o número alternativo na mensagem, ou no mapa do WhatsApp, aceito.
    await t.upsert(msg("555@lid", "quem?"));
    expect(t.drops.at(-1)).toBe("sender_unmatched");
    await t.upsert(msg("555@lid", "com alternativo", {}, { remoteJidAlt: pn(OTHER) }));
    t.sockets[0]!.signalRepository.lidMapping.getLIDForPN = async () => "777@lid";
    await t.upsert(msg("777@lid", "pelo mapa"));
    expect(t.texts).toEqual(["oi", "com alternativo", "pelo mapa"]);
    // O mapa passa a apontar o @lid para outro número: deixa de valer.
    t.sockets[0]!.ev.emit("lid-mapping.update", { lid: "777@lid", pn: pn("5511666660000") });
    await t.upsert(msg("777@lid", "agora não"));
    expect(t.texts).toHaveLength(3);
    t.sockets[0]!.signalRepository.lidMapping.getLIDForPN = async () => {
      throw new Error("fora do ar");
    };
    await t.upsert(msg("888@lid", "consulta falhou"));
    expect(t.drops.at(-1)).toBe("lid_lookup_failed");
  });

  it("áudio ou foto recebe um aviso curto, no máximo um por minuto; reação é ignorada", async () => {
    const t = await linked("self-chat");
    await t.upsert({ ...msg(pn(OWN), "", {}, { fromMe: true }), message: { audioMessage: { seconds: 3 } } }, { ...msg(pn(OWN), "", {}, { fromMe: true }), message: { imageMessage: {} } });
    expect(t.texts).toEqual([]);
    expect(t.sockets[0]!.sent).toHaveLength(1);
    expect(t.sockets[0]!.sent[0]!.content.text).toMatch(/só consigo ler texto/);
    await t.upsert({ ...msg(pn(OWN), "", {}, { fromMe: true }), message: { reactionMessage: { text: "👍" } } }, { ...msg(pn(OWN), "", {}, { fromMe: true }), message: {}, messageStubType: 2 });
    expect(t.sockets[0]!.sent).toHaveLength(1);
    expect(t.drops.at(-1)).toBe("decrypt_failed");
  });
});

describe("WhatsApp por QR code: resposta e reconexão", () => {
  it("a resposta vai só para a dona, o eco não vira pedido e envio sem confirmação não é repetido", async () => {
    const t = await linked("self-chat");
    await t.channel.sendText("Está em dia.");
    const s = t.sockets[0]!;
    expect(s.sent).toMatchObject([{ jid: pn(OWN), content: { text: "Está em dia.", linkPreview: null } }]);
    expect(JSON.parse(t.store.data.get("sent-ids")!)).toEqual([s.sent[0]!.id]);
    await t.upsert(msg(pn(OWN), "Está em dia.", {}, { fromMe: true, id: s.sent[0]!.id }));
    expect(t.texts).toEqual([]);
    expect(t.drops.at(-1)).toBe("own_echo");
    // Texto longo vira várias mensagens.
    await t.channel.sendText(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    expect(s.sent).toHaveLength(3);
    expect(splitText("x ".repeat(5000)).every((p) => p.length <= 3800)).toBe(true);
    s.confirm = false;
    await expect(t.channel.sendText("oi")).rejects.toThrow(/não confirmou/);
    expect(s.sent).toHaveLength(4);

    const b = await linked("bot", { allowedNumber: OTHER });
    await b.channel.sendText("oi");
    expect(b.sockets[0]!.sent[0]!.jid).toBe(pn(OTHER));
    await b.upsert(msg("555@lid", "por lid", {}, { remoteJidAlt: pn(OTHER) }));
    await b.channel.sendText("resposta");
    expect(b.sockets[0]!.sent[1]!.jid).toBe("555@lid");
  });

  it("queda comum reconecta; desconectado pelo celular apaga as chaves; conexão substituída para sem apagar", async () => {
    const t = await linked("self-chat");
    t.sockets[0]!.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.sockets).toHaveLength(2);
    // O soquete antigo não fala mais.
    t.sockets[0]!.ev.emit("messages.upsert", { messages: [msg(pn(OWN), "velho", {}, { fromMe: true })] });
    await tick();
    expect(t.texts).toEqual([]);
    t.sockets[1]!.ev.emit("connection.update", { connection: "open" });
    await tick();
    expect(t.channel.state).toBe("connected");
    await expect(t.channel.sendText("oi")).resolves.toBeUndefined();

    t.sockets[1]!.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 440 } } } });
    expect(t.channel.state).toBe("failed");
    expect(t.store.data.has("creds")).toBe(true);
    await expect(t.channel.sendText("oi")).rejects.toThrow(/não está conectado/);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.sockets).toHaveLength(2);

    const out = await linked("self-chat");
    out.sockets[0]!.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await tick();
    expect(out.channel.state).toBe("logged_out");
    expect(out.store.data.size).toBe(0);
  });

  it("desvincular avisa o WhatsApp e apaga as chaves", async () => {
    const t = await linked("self-chat");
    await t.channel.unlink();
    expect(t.sockets[0]!.loggedOut).toBe(true);
    expect(t.store.data.size).toBe(0);
  });
});

describe("WhatsApp por QR code: arquivos e ponte com o hub", () => {
  it("as chaves ficam em arquivos 0600, com nomes que não escapam da pasta", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "puxibot-wa-"));
    const store = fileSlotStore(path.join(dir, "session"));
    await store.set({ creds: "{}", "session:../../etc/passwd": "x", "pre-key:1": "y" });
    expect(await store.get("session:../../etc/passwd")).toBe("x");
    const files = await fs.readdir(path.join(dir, "session"));
    expect(files).toHaveLength(3);
    for (const f of files) {
      expect(f).toMatch(/^[0-9a-f]{40}\.json$/);
      expect((await fs.stat(path.join(dir, "session", f))).mode & 0o777).toBe(0o600);
    }
    await store.set({ "pre-key:1": null });
    expect(await store.get("pre-key:1")).toBeUndefined();
    await store.clear();
    expect(await store.get("creds")).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("mensagem da dona vai ao hub com o agente configurado; o texto do hub volta pelo WhatsApp", async () => {
    const { lib, sockets } = fake();
    const store = memorySlotStore();
    await store.set({ creds: JSON.stringify({ me: { id: `${OWN}:7@s.whatsapp.net` } }) });
    const sent: RunnerToHub[] = [];
    expect(await startWhatsAppBridge({}, (m) => sent.push(m), silentLogger, { lib, store })).toBeNull();
    const bridge = (await startWhatsAppBridge({ whatsapp: { enabled: true, mode: "self-chat", agent: "assistente" } }, (m) => sent.push(m), silentLogger, { lib, store }))!;
    sockets[0]!.ev.emit("connection.update", { connection: "open" });
    await tick();
    sockets[0]!.ev.emit("messages.upsert", { messages: [msg(pn(OWN), "resuma meu dia", {}, { fromMe: true })] });
    await tick();
    expect(sent).toEqual([{ type: "chat.inbound", provider: "whatsapp", agent: "assistente", text: "resuma meu dia" }]);
    bridge.deliver({ type: "chat.send", provider: "whatsapp", text: "Três reuniões." });
    await tick();
    expect(sockets[0]!.sent.at(-1)).toMatchObject({ jid: pn(OWN), content: { text: "Três reuniões." } });
    await bridge.stop();
  });
});
