/**
 * Log do runner. Tudo que sai daqui passa por `redact`, que apaga tokens do
 * Puxibot (`tb_...`, `tbj_...`) e cabeçalhos de autorização.
 */

const TOKEN_RE = /\b(tbj?_)[A-Za-z0-9._~+/=-]+/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const OAUTH_RE = /\b(sk-ant-[a-z0-9]+-)[A-Za-z0-9_-]+/g;

export function redact(text: string): string {
  return text.replace(TOKEN_RE, "$1***").replace(BEARER_RE, "$1***").replace(OAUTH_RE, "$1***");
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function envLevel(): LogLevel {
  const v = process.env.PUXIBOT_LOG_LEVEL;
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

export function createLogger(scope = "puxibot", sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  const min = ORDER[envLevel()];
  const emit = (level: LogLevel, msg: string) => {
    if (ORDER[level] < min) return;
    const time = new Date().toISOString().slice(11, 19);
    sink(redact(`[${time}] ${level === "info" ? "" : level.toUpperCase() + " "}${scope}: ${msg}`));
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
