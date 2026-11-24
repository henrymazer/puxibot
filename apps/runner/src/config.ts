/**
 * Configuração local do runner em `~/.puxibot/` (ou `PUXIBOT_HOME`).
 *
 *   config.json      hub, workspace, runnerId e preferências (sem segredos)
 *   token            token do runner (tb_...), permissão 0600
 *   sessions.json    mapa sessionKey -> id de sessão da CLI
 *   runner.pid       pid do `puxibot start` em execução
 *   workspaces/<ws>/agents/<agentId>/   pasta de trabalho de cada agente
 *   cli-state/<cli>/<ws>/<agentId>/ estado próprio da CLI de cada agente (sessões, cache),
 *                    separado do da pessoa e do dos outros agentes
 *   run/<jobId>/     arquivos temporários de um job (apagados ao terminar)
 */
import { promises as fs, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Cli, IsolationMode } from "@puxibot/shared";

export interface RunnerConfig {
  hubUrl?: string;
  workspaceId?: string;
  runnerId?: string | null;
  name?: string;
  isolation?: IsolationMode;
  capacity?: number;
  /** CLI usada quando o agente não tem `preferredCli`. */
  defaultCli?: Cli;
  /** Modelo padrão por CLI, quando o agente não define `preferredModel`. */
  models?: Partial<Record<Cli, string>>;
  /** Caminho do executável de cada CLI (padrão: procurar no PATH). */
  cliPaths?: Partial<Record<Cli, string>>;
  sandbox?: {
    /**
     * Pastas ou arquivos escondidos além do padrão (a pasta pessoal, /home, /root, /mnt,
     * /media, discos externos e ~/.puxibot já ficam escondidos). Úteis dentro de pastas
     * liberadas com `extraReadOnly`/`extraWritable`. Aceita "~/".
     */
    hidePaths?: string[];
    /** Pastas extras liberadas somente leitura (ex.: ["~/projetos/site"]). Aceita "~/". */
    extraReadOnly?: string[];
    /** Pastas extras com escrita liberada. Aceita "~/". */
    extraWritable?: string[];
    /** `false` corta a rede no modo sandbox (Linux). Padrão: rede liberada. */
    network?: boolean;
  };
  /**
   * Variáveis de ambiente do seu terminal que o agente recebe além das básicas (PATH, LANG,
   * LC_*, TERM, TZ, HOME, proxy...). Nos modos sandbox e container, o resto não passa.
   * Ex.: { "pass": ["ANTHROPIC_API_KEY"] }.
   */
  env?: { pass?: string[] };
  /**
   * Revisão automática de memória ao fim de cada trabalho (uma chamada curta a mais, na sua
   * assinatura). `auto: false` desliga neste computador; `model` troca o modelo usado.
   */
  memory?: { auto?: boolean; model?: string };
  /**
   * Procedimentos aprendidos: depois de um trabalho com vários passos, a mesma chamada curta da
   * revisão de memória escreve o roteiro seguido, para reutilizar. `learn: false` desliga.
   */
  skills?: { learn?: boolean };
  /**
   * Navegador para os agentes (servidor MCP do Playwright). Desligado por padrão: a pessoa dona do
   * computador liga aqui, e o responsável pelo agente liga o navegador no perfil dele.
   * `command`/`args` trocam o comando (padrão: `npx -y @playwright/mcp@latest --headless --isolated`).
   */
  browser?: { enabled?: boolean; command?: string; args?: string[] };
  /**
   * Quanto o agente espera por uma aprovação de ação antes de seguir sem ela (padrão 600 s).
   * A aprovação continua valendo na tela enquanto o trabalho não terminar.
   */
  approvals?: { waitSeconds?: number };
  /**
   * WhatsApp vinculado por QR code neste computador (`puxibot whatsapp conectar`), para você conversar
   * com um agente seu. `mode`: "self-chat" (seu próprio número) ou "bot" (um número separado, que só
   * aceita mensagens de `allowedNumber`). As chaves ficam em `whatsapp/session/`, fora deste arquivo.
   */
  whatsapp?: { enabled?: boolean; mode?: "self-chat" | "bot"; allowedNumber?: string; agent?: string };
  container?: {
    runtime?: "docker" | "podman";
    /** Imagem própria; padrão: construída a partir de docker/Dockerfile. */
    image?: string;
    /** Valor de `--network` (padrão: rede padrão do runtime). Ex.: "none". */
    network?: string;
  };
}

export function puxibotHome(): string {
  if (process.env.PUXIBOT_HOME) return path.resolve(process.env.PUXIBOT_HOME);
  const home = path.join(os.homedir(), ".puxibot");
  migrateLegacyHome(home);
  return home;
}

let legacyChecked = false;
/** O projeto se chamava Timebot: quem instalou antes da troca de nome tem a pasta com o nome antigo. */
function migrateLegacyHome(home: string): void {
  if (legacyChecked) return;
  legacyChecked = true;
  const legacy = path.join(os.homedir(), "." + "time" + "bot");
  try {
    if (!existsSync(home) && existsSync(legacy)) renameSync(legacy, home);
  } catch {
    /* sem permissão ou em uso: a pessoa pareia de novo com `puxibot login` */
  }
}

export const paths = {
  home: () => puxibotHome(),
  config: () => path.join(puxibotHome(), "config.json"),
  token: () => path.join(puxibotHome(), "token"),
  sessions: () => path.join(puxibotHome(), "sessions.json"),
  pid: () => path.join(puxibotHome(), "runner.pid"),
  /** Estado da CLI de um agente (separado por agente: um agente não lê as conversas de outro). */
  cliState: (cli: Cli, workspaceId: string, agentId: string) =>
    path.join(puxibotHome(), "cli-state", cli, safeSegment(workspaceId), safeSegment(agentId)),
  runDir: (jobId: string) => path.join(puxibotHome(), "run", safeSegment(jobId)),
  agentDir: (workspaceId: string, agentId: string) =>
    path.join(puxibotHome(), "workspaces", safeSegment(workspaceId), "agents", safeSegment(agentId)),
};

/** Impede que ids vindos do hub escapem da pasta (`..`, `/`). */
export function safeSegment(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return s.length ? s.slice(0, 128) : "_";
}

export function ensureHome(): void {
  mkdirSync(puxibotHome(), { recursive: true, mode: 0o700 });
  try {
    chmodSync(puxibotHome(), 0o700);
  } catch {
    /* sistemas de arquivos sem chmod (ex.: montagens do Windows) */
  }
}

function writeAtomic(file: string, content: string, mode: number): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export function loadConfig(): RunnerConfig {
  try {
    return JSON.parse(readFileSync(paths.config(), "utf8")) as RunnerConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: RunnerConfig): void {
  ensureHome();
  writeAtomic(paths.config(), JSON.stringify(cfg, null, 2) + "\n", 0o600);
}

export function updateConfig(patch: Partial<RunnerConfig>): RunnerConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

export function loadToken(): string | null {
  try {
    const t = readFileSync(paths.token(), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  ensureHome();
  writeAtomic(paths.token(), token.trim() + "\n", 0o600);
}

export async function deleteToken(): Promise<void> {
  await fs.rm(paths.token(), { force: true });
}

/** Permissão do arquivo de token (ex.: 0o600), ou null se não existe. */
export function tokenFileMode(): number | null {
  if (!existsSync(paths.token())) return null;
  return statSync(paths.token()).mode & 0o777;
}
// ---------- Sessões da CLI ----------
export interface SessionEntry {
  cli: Cli;
  sessionId: string;
  updatedAt: number;
}

export class SessionStore {
  constructor(private readonly file = paths.sessions()) {}

  private read(): Record<string, SessionEntry> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, SessionEntry>;
    } catch {
      return {};
    }
  }

  get(sessionKey: string, cli: Cli): SessionEntry | null {
    const e = this.read()[sessionKey];
    return e && e.cli === cli ? e : null;
  }

  set(sessionKey: string, entry: SessionEntry): void {
    const all = this.read();
    all[sessionKey] = entry;
    writeAtomic(this.file, JSON.stringify(all, null, 2) + "\n", 0o600);
  }

  delete(sessionKey: string): void {
    const all = this.read();
    if (!(sessionKey in all)) return;
    delete all[sessionKey];
    writeAtomic(this.file, JSON.stringify(all, null, 2) + "\n", 0o600);
  }
}
