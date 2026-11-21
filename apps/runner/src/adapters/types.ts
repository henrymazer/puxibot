/**
 * Interface única dos adaptadores de CLI de IA. Cada adaptador sabe iniciar a
 * CLI em modo não interativo, entregar as instruções, registrar o servidor MCP
 * do Puxibot, ler a saída em streaming e retomar sessões.
 */
import type { Cli, IsolationMode, JobAssignment, JobErrorCode } from "@puxibot/shared";

export interface CliStatus {
  cli: Cli;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** null quando não dá para saber sem gastar uso. */
  loggedIn: boolean | null;
  detail?: string;
}

/** Arquivo ou pasta de credenciais da CLI que precisa ser visível no isolamento. */
export interface CredentialMount {
  path: string;
  writable: boolean;
  /** Por que precisa de escrita (vai para o log de depuração). */
  reason?: string;
}

/** Como iniciar o `puxibot mcp` do ponto de vista da CLI (dentro do isolamento). */
export interface McpLaunch {
  command: string;
  args: string[];
}

export interface PrepareInput {
  assignment: JobAssignment;
  /** Pasta de trabalho do agente (cwd da CLI). */
  workdir: string;
  /** Pasta temporária do job, apagada ao terminar. */
  runDir: string;
  /** Instruções fixas do agente (prompt de sistema adicional / arquivo de instruções). */
  systemPrompt: string;
  /** Pedido + contexto dinâmico (mensagens, memórias, colegas). */
  userPrompt: string;
  model: string | null;
  resumeSessionId: string | null;
  isolation: IsolationMode;
  mcp: McpLaunch;
  /** Como iniciar o `puxibot mcp-proxy` (intermediário dos conectores somente leitura). */
  mcpProxy: McpLaunch;
  /**
   * Como iniciar o `puxibot mcp-exec` (lança um conector stdio com as variáveis dele, sem
   * que elas entrem no ambiente da CLI). Opcional: só o Codex usa.
   */
  mcpExec?: McpLaunch;
  /** Variáveis para o servidor MCP. Entram no ambiente da CLI (nunca em arquivo ou argv). */
  mcpEnv: Record<string, string>;
  /** Ambiente base já limpo. */
  baseEnv: Record<string, string>;
  /** Executável da CLI no host (ignorado no modo container, que usa o da imagem). */
  binPath: string;
  /**
   * Chamada utilitária (revisão de memória): `systemPrompt` substitui as instruções da CLI,
   * sem ferramentas nativas, sem servidores MCP e sem retomar sessão.
   */
  utility?: boolean;
}

export interface PreparedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin?: string;
  credentials: CredentialMount[];
  /** Pastas que a CLI precisa escrever além da pasta de trabalho (estado próprio). */
  writable: string[];
  /** Pastas que a CLI precisa ler e que ficam escondidas por padrão. */
  readable: string[];
  /** Executado depois que o processo termina (sincronizar credenciais etc.). */
  afterRun?: () => Promise<void>;
}

export type AdapterEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "session"; id: string }
  | { type: "model"; model: string };

export interface AdapterResult {
  ok: boolean;
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  sessionId: string | null;
  errorCode?: JobErrorCode;
  error?: string;
  /** A sessão pedida não existe mais; vale tentar de novo sem retomar. */
  resumeFailed?: boolean;
}

export interface StreamParser {
  line(line: string): AdapterEvent[];
  finish(exit: { code: number | null; signal: NodeJS.Signals | null }, stderr: string): AdapterResult;
}

export interface CliAdapter {
  cli: Cli;
  displayName: string;
  /** Executável padrão (no PATH do host e dentro da imagem de container). */
  binName: string;
  /** Pacote npm instalado na imagem de container. */
  npmPackage: string;
  /** false = implementado a partir da documentação, sem execução real. */
  verified: boolean;
  /** Pasta onde a CLI procura skills, relativa à pasta de trabalho. */
  skillsDir: string;
  /**
   * Variáveis de login por chave de API que o adaptador aceita de propósito (documentadas).
   * Passam para a CLI nos modos sandbox e container; as outras do terminal não passam.
   */
  authEnv?: string[];
  /**
   * Modelo barato para chamadas utilitárias (revisão de memória). Sem isto, o adaptador não
   * tem modo utilitário e a revisão automática não roda com essa CLI.
   */
  utilityModel?: string;
  detect(binPath: string | null): Promise<CliStatus>;
  prepare(input: PrepareInput): Promise<PreparedCommand>;
  createParser(ctx: { model: string | null }): StreamParser;
}

// ---------- Conectores ----------
/**
 * Nomes que um conector (definido no hub) não pode definir: mudariam como o runner, o
 * isolamento, a CLI ou o `puxibot mcp` funcionam.
 */
const DANGEROUS_ENV = /^(PATH|HOME|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|CODEX_HOME|LD_.*|DYLD_.*|CLAUDE_.*|CLAUDECODE.*|GEMINI_.*|PUXIBOT_.*)$/i;

export function isDangerousConnectorEnv(name: string): boolean {
  return DANGEROUS_ENV.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Tira do ambiente de um conector os nomes perigosos; devolve o que sobrou e o que saiu. */
export function filterConnectorEnv(env: Record<string, string>): { env: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (isDangerousConnectorEnv(k)) dropped.push(k);
    else out[k] = v;
  }
  return { env: out, dropped };
}

export type ConnectorServer =
  | { transport: "http"; url: string; headers: Record<string, string> }
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> };

/**
 * Como a CLI deve iniciar um conector. Com `level: 'read'` a CLI fala com o
 * `puxibot mcp-proxy`, que só expõe as ferramentas marcadas `readOnlyHint` pelo servidor
 * (ver mcp/readonlyProxy.ts); a configuração do conector vai na variável `env`.
 * `null` = conector sem acesso ou incompleto.
 */
export function connectorServer(c: JobAssignment["connectors"][number], proxy: McpLaunch, index: number): ConnectorServer | null {
  if (c.level === "none") return null;
  const complete = (c.transport === "http" && !!c.url) || (c.transport === "stdio" && !!c.command);
  if (!complete) return null;
  if (c.level === "read") {
    const varName = `PUXIBOT_RO_CONNECTOR_${index}`;
    const cfg = { name: c.name, transport: c.transport, url: c.url, headers: c.headers, command: c.command, args: c.args, env: c.env };
    return { transport: "stdio", command: proxy.command, args: [...proxy.args, "--config-env", varName], env: { [varName]: JSON.stringify(cfg) } };
  }
  if (c.transport === "http") return { transport: "http", url: c.url!, headers: c.headers };
  return { transport: "stdio", command: c.command!, args: c.args, env: c.env };
}

// ---------- Classificação de erros comum ----------
const AUTH_RE =
  /(not logged in|please run \/login|invalid api key|authentication[_ ]failed|unauthori[sz]ed|\b401\b|oauth token (has )?expired|token (has )?expired|login required|please log ?in|credentials? (not found|missing|invalid)|UNAUTHENTICATED|invalid_grant)/i;
const LIMIT_RE =
  /(usage limit|limit reached|rate[_ ]limit|hit your limit|5-hour limit|weekly limit|quota|RESOURCE_EXHAUSTED|\b429\b|too many requests|usage_limit_reached|out of credits|credit balance is too low)/i;

export function classifyError(text: string): JobErrorCode | null {
  if (AUTH_RE.test(text)) return "auth";
  if (LIMIT_RE.test(text)) return "limit";
  return null;
}

/** Resumo curto dos argumentos de uma ferramenta, sem valores longos. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (parts.length >= 3) break;
    if (/token|secret|password|senha|key/i.test(k)) continue;
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s === undefined) continue;
    s = s.replace(/\s+/g, " ");
    if (s.length > 60) s = s.slice(0, 57) + "...";
    parts.push(`${k}: ${s}`);
  }
  return parts.join(", ");
}

/** Nome amigável de ferramenta: tira prefixos de MCP (`mcp__puxibot__x`, `mcp_puxibot_x`). */
export function friendlyToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (m) return m[1] === "puxibot" ? m[2]! : `${m[1]}/${m[2]}`;
  if (name.startsWith("mcp_puxibot_")) return name.slice("mcp_puxibot_".length);
  return name;
}
