/**
 * Conexão de saída com o hub por WebSocket: hello, ping, reconexão com backoff e
 * fila de mensagens importantes enquanto a conexão está fora do ar.
 */
import WebSocket from "ws";
import type { HubToRunner, RunnerToHub } from "@puxibot/shared";
import type { Logger } from "./log.js";

export interface HubConnectionOptions {
  hubUrl: string;
  workspaceId: string;
  token: string;
  /** Monta o hello a cada (re)conexão, com o runnerId mais recente. */
  hello: () => Extract<RunnerToHub, { type: "hello" }>;
  onMessage: (msg: HubToRunner) => void;
  /** Chamado a cada `welcome` (primeira conexão e reconexões). */
  onWelcome?: (msg: Extract<HubToRunner, { type: "welcome" }>, reconnect: boolean) => void;
  /** Hub recusou o token: não adianta tentar de novo. */
  onFatal?: (reason: string) => void;
  logger: Logger;
  pingIntervalMs?: number;
  /** Sem nenhuma mensagem do hub por este tempo, a conexão é dada como morta. */
  idleTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** Mensagens que não podem se perder numa queda; o resto é descartado fora do ar. */
const CRITICAL = new Set<RunnerToHub["type"]>(["job.accepted", "job.rejected", "job.done", "job.failed", "job.event"]);
const MAX_OUTBOX = 500;

export function runnerWsUrl(hubUrl: string, workspaceId: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(workspaceId)}/runner`;
  u.search = "";
  return u.toString();
}

export class HubConnection {
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private attempt = 0;
  private everWelcomed = false;
  private outbox: RunnerToHub[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HubConnectionOptions) {}

  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  send(msg: RunnerToHub): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (CRITICAL.has(msg.type)) {
      this.outbox.push(msg);
      if (this.outbox.length > MAX_OUTBOX) this.outbox.splice(0, this.outbox.length - MAX_OUTBOX);
    }
  }

  /** Espera o envio do que estiver no buffer do socket (até `timeoutMs`). */
  async flush(timeoutMs = 2000): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const start = Date.now();
    while (ws.bufferedAmount > 0 && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 20));
  }

  async stop(code = 1000, reason = "runner encerrado"): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 2000);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    });
  }

  /** Força uma queda (testes / diagnóstico). */
  dropForTest(): void {
    this.ws?.terminate();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = runnerWsUrl(this.opts.hubUrl, this.opts.workspaceId);
    const log = this.opts.logger;
    log.debug(`conectando a ${url}`);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.token}` }, handshakeTimeout: 15_000 });
    this.ws = ws;
    let fatal = false;

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      if (status === 401 || status === 403) {
        fatal = true;
        const reason =
          status === 401
            ? "o hub recusou o token deste runner (revogado ou inválido). Rode `puxibot login` de novo."
            : "o token não tem acesso a este workspace. Rode `puxibot login` de novo.";
        log.error(reason);
        this.stopped = true;
        this.opts.onFatal?.(reason);
      } else {
        log.warn(`o hub respondeu ${status} ao abrir a conexão`);
      }
      ws.terminate();
    });

    ws.on("open", () => {
      log.debug("conexão aberta; enviando hello");
      ws.send(JSON.stringify(this.opts.hello()));
      this.touch();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" } satisfies RunnerToHub));
      }, this.opts.pingIntervalMs ?? 20_000);
    });

    ws.on("message", (data) => {
      this.touch();
      let msg: HubToRunner;
      try {
        msg = JSON.parse(String(data)) as HubToRunner;
      } catch {
        log.warn("mensagem inválida do hub (ignorada)");
        return;
      }
      if (msg.type === "welcome") {
        const reconnect = this.everWelcomed;
        this.everWelcomed = true;
        this.ready = true;
        this.attempt = 0;
        log.info(reconnect ? "reconectado ao hub" : `conectado ao hub como runner ${msg.runnerId}`);
        const queued = this.outbox.splice(0);
        for (const m of queued) ws.send(JSON.stringify(m));
        this.opts.onWelcome?.(msg, reconnect);
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "error") log.warn(`hub: ${msg.message} (${msg.code})`);
      this.opts.onMessage(msg);
    });

    ws.on("error", (err) => {
      log.debug(`erro na conexão: ${err.message}`);
    });

    ws.on("close", (code, reasonBuf) => {
      this.clearTimers();
      const wasReady = this.ready;
      this.ready = false;
      if (this.ws === ws) this.ws = null;
      if (this.stopped || fatal) return;
      if (code === 4001 || code === 4003) {
        // Convenção: o hub fecha com 4001/4003 quando o token foi revogado ou o runner removido
        // (`puxibot logout` ou pela interface).
        const hubReason = reasonBuf?.toString().trim().slice(0, 200);
        const reason = `o hub encerrou a conexão${hubReason ? ` (${hubReason})` : ""}: token revogado ou runner removido. Rode \`puxibot login\` de novo para voltar.`;
        log.error(reason);
        this.stopped = true;
        this.opts.onFatal?.(reason);
        return;
      }
      const delay = this.nextDelay();
      if (wasReady) log.warn(`conexão com o hub caiu (código ${code}); tentando de novo em ${Math.round(delay / 100) / 10} s`);
      else log.debug(`sem conexão com o hub; nova tentativa em ${Math.round(delay / 100) / 10} s`);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private nextDelay(): number {
    const base = this.opts.backoffBaseMs ?? 1000;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const exp = Math.min(max, base * 2 ** this.attempt);
    this.attempt++;
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ws = this.ws;
    this.idleTimer = setTimeout(() => {
      this.opts.logger.warn("hub sem responder; reconectando");
      ws?.terminate();
    }, this.opts.idleTimeoutMs ?? 50_000);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.pingTimer = null;
    this.idleTimer = null;
  }
}
