/**
 * Conexão WebSocket com o hub: reconexão com espera crescente, ping periódico
 * e aviso de reconexão para a interface ressincronizar.
 */
import type { ClientCommand, ClientEvent } from "@puxibot/shared";

/** O mínimo de WebSocket que usamos (permite um socket falso no modo demonstração e em testes). */
export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

/**
 * `too_many`: o hub fechou esta conexão com 4008 (conexões demais da mesma pessoa; a mais antiga sai).
 * Não reconecta sozinho, senão duas abas ficariam se derrubando em laço; a pessoa reconecta quando quiser.
 */
export type ConnectionStatus = "connecting" | "online" | "offline" | "too_many";

/** Código de fechamento do hub: conexões demais abertas pela mesma pessoa. */
export const CLOSE_TOO_MANY = 4008;

export interface RealtimeOptions {
  url: string;
  createSocket?: SocketFactory;
  onEvent: (event: ClientEvent) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Chamado a cada conexão bem-sucedida depois da primeira. */
  onReconnect?: () => void;
  pingMs?: number;
}

const OPEN = 1;

export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.75 + random() * 0.5));
}

export class RealtimeConnection {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private everConnected = false;
  private stopped = true;
  /** Parado depois de um 4008: só volta com `reconnect()`. */
  private paused = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: RealtimeOptions;

  constructor(opts: RealtimeOptions) {
    this.opts = opts;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.wake);
      document.addEventListener("visibilitychange", this.wake);
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.wake);
      document.removeEventListener("visibilitychange", this.wake);
    }
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
  }

  send(cmd: ClientCommand): boolean {
    if (this.socket && this.socket.readyState === OPEN) {
      this.socket.send(JSON.stringify(cmd));
      return true;
    }
    return false;
  }

  /** Reconexão pedida pela pessoa (depois de um 4008). */
  reconnect(): void {
    if (this.stopped || this.socket) return;
    this.paused = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private wake = (): void => {
    if (this.stopped || this.paused) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (!this.socket && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.attempt = 0;
      this.connect();
    }
  };

  private connect(): void {
    this.opts.onStatus?.("connecting");
    const factory: SocketFactory = this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    let socket: SocketLike;
    try {
      socket = factory(this.opts.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const isReconnect = this.everConnected;
      this.everConnected = true;
      this.attempt = 0;
      this.opts.onStatus?.("online");
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.opts.pingMs ?? 25_000);
      if (isReconnect) this.opts.onReconnect?.();
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        this.opts.onEvent(parsed as ClientEvent);
      }
    };
    socket.onerror = () => {
      /* o onclose cuida da reconexão */
    };
    socket.onclose = (ev) => {
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      if ((ev as { code?: number } | null)?.code === CLOSE_TOO_MANY) {
        this.paused = true;
        this.opts.onStatus?.("too_many");
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    this.opts.onStatus?.("offline");
    const delay = backoffDelay(this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }
}
