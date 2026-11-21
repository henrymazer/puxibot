/** Utilidades de processo: ambiente limpo, grupo de processos e encerramento da árvore. */
import { spawn, type ChildProcess, execFile } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Variáveis herdadas que mudam o comportamento da CLI filha. O runner pode estar
 * rodando dentro de uma sessão de uma dessas CLIs (por exemplo quando é iniciado
 * por um agente), e a filha não pode achar que é uma sub-sessão.
 */
const STRIP_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CONFIG_DIR",
  "MCP_CONNECTION_NONBLOCKING",
  "CODEX_HOME",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "GEMINI_CLI_HOME",
  "GEMINI_SANDBOX",
  "GEMINI_SYSTEM_MD",
  "SANDBOX",
  "PUXIBOT_JOB_TOKEN",
  "PUXIBOT_HUB_URL",
  "PUXIBOT_TOOL_PERMS",
]);
const STRIP_PREFIX = ["CLAUDE_CODE_", "CLAUDECODE_", "CODEX_INTERNAL_", "SRT_"];

export function cleanEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP_EXACT.has(k)) continue;
    if (STRIP_PREFIX.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Variáveis do terminal que a CLI recebe nos modos sandbox e container. O resto (tokens do
 * GitHub, chaves de nuvem, DATABASE_URL...) não passa; `env.pass` no config.json acrescenta
 * nomes escolhidos pela pessoa.
 */
const CHILD_ENV_ALLOW = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  // Rede corporativa: sem proxy/certificado a CLI não alcança o modelo.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

export function childEnv(opts: { pass?: string[]; extra?: string[] } = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const explicit = new Set([...(opts.pass ?? []), ...(opts.extra ?? [])]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanEnv(base))) {
    if (CHILD_ENV_ALLOW.has(k) || k.startsWith("LC_") || explicit.has(k)) out[k] = v;
  }
  // Pedido explícito da pessoa vale mesmo para nomes que o cleanEnv tira (exceto os do Puxibot).
  for (const k of opts.pass ?? []) {
    const v = base[k];
    if (v !== undefined && !k.startsWith("PUXIBOT_")) out[k] = v;
  }
  return out;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Texto enviado ao stdin (que depois é fechado). */
  stdin?: string;
}

export interface RunningProcess {
  child: ChildProcess;
  /** Resolve quando o processo termina. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Mata o processo e todos os filhos (grupo de processos). */
  kill(graceMs?: number): Promise<void>;
}

/** Inicia um processo líder de um grupo próprio, para poder matar a árvore inteira. */
export function spawnGroup(
  spec: SpawnSpec,
  onStdoutLine: (line: string) => void,
  onStderr: (chunk: string) => void,
  extraKill?: () => Promise<void>,
): RunningProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let done = false;
    child.once("error", (err) => {
      onStderr(`falha ao iniciar ${spec.command}: ${err.message}\n`);
      if (!done) {
        done = true;
        resolve({ code: 127, signal: null });
      }
    });
    child.once("close", (code, signal) => {
      if (!done) {
        done = true;
        resolve({ code, signal });
      }
    });
  });
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", onStdoutLine);
  }
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => onStderr(d));
  child.stdin?.on("error", () => {});
  if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
  else child.stdin?.end();

  let killing: Promise<void> | null = null;
  const kill = (graceMs = 3000): Promise<void> => {
    if (killing) return killing;
    killing = (async () => {
      if (extraKill) await extraKill().catch(() => {});
      signalGroup(child, "SIGTERM");
      const t = setTimeout(() => signalGroup(child, "SIGKILL"), graceMs);
      await exited;
      clearTimeout(t);
      // Garante que netos que ignoraram o SIGTERM também morram.
      signalGroup(child, "SIGKILL");
    })();
    return killing;
  };
  return { child, exited, kill };
}

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* já terminou */
    }
  }
}

/** Executa um comando curto e devolve stdout/stderr (para detecção). */
export function run(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: opts.timeoutMs ?? 10_000, env: opts.env ?? cleanEnv(), cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Procura um executável no PATH. */
export async function which(cmd: string): Promise<string | null> {
  if (cmd.includes("/")) {
    const { access, constants } = await import("node:fs/promises");
    try {
      await access(cmd, constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const { access, constants } = await import("node:fs/promises");
  const path = await import("node:path");
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      /* próximo */
    }
  }
  return null;
}
