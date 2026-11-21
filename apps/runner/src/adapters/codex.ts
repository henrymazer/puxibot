/**
 * Adaptador do Codex CLI.
 *
 * ATENÇÃO: NÃO VERIFICADO COM EXECUÇÃO REAL. Montado a partir de `codex --help`,
 * `codex exec --help`, `codex exec resume --help` (codex-cli 0.171) e dos nomes de
 * eventos presentes no binário. Suposições marcadas com [SUPOSIÇÃO].
 *
 * Linha de comando:
 *   codex exec --json --skip-git-repo-check -C <pasta> [-m modelo]
 *              [--dangerously-bypass-approvals-and-sandbox | -s workspace-write]
 *              -c mcp_servers.puxibot.command=... -c mcp_servers.puxibot.args=[...]
 *              -c mcp_servers.puxibot.env_vars=[...]   -        (prompt pelo stdin)
 *   retomada: codex exec resume <id> --json ... -
 *
 * Instruções do agente: AGENTS.md na pasta de trabalho (lido pelo Codex).
 * Estado: CODEX_HOME = ~/.puxibot/cli-state/codex/<ws>/<agente>, com auth.json ligado ao da pessoa.
 */
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../config.js";
import { run } from "../proc.js";
import { safeWriteFile } from "../safefs.js";
import { connectorServerName } from "./claude.js";
import { isCodexAuth, syncCredentialLink } from "./credentials.js";
import {
  classifyError,
  connectorServer,
  summarizeToolInput,
  type AdapterEvent,
  type AdapterResult,
  type CliAdapter,
  type CliStatus,
  type PrepareInput,
  type PreparedCommand,
  type StreamParser,
} from "./types.js";

export function userCodexHome(): string {
  return process.env.PUXIBOT_USER_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** Valor TOML para `-c chave=valor`. JSON de strings/arrays/objetos simples é TOML válido como inline. */
function toml(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(toml).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`)
      .join(", ")} }`;
  }
  return String(v);
}

/** Link `auth.json` do estado do agente -> login da pessoa (cópia de volta só com `copyBack`). */
function linkAuth(stateDir: string, userAuth: string, copyBack: boolean) {
  return syncCredentialLink({ stateRoot: stateDir, stateFile: path.join(stateDir, "auth.json"), userFile: userAuth, copyBack, validate: isCodexAuth });
}

export const codexAdapter: CliAdapter = {
  cli: "codex",
  displayName: "Codex CLI",
  binName: "codex",
  npmPackage: "@openai/codex",
  verified: false,
  // [SUPOSIÇÃO] o Codex procura skills em .agents/skills na pasta do projeto.
  skillsDir: ".agents/skills",

  async detect(binPath): Promise<CliStatus> {
    if (!binPath) return { cli: "codex", installed: false, path: null, version: null, loggedIn: null };
    const v = await run(binPath, ["--version"], { timeoutMs: 15_000 });
    const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
    // `codex login status` só lê o arquivo local de login.
    const s = await run(binPath, ["login", "status"], { timeoutMs: 15_000 });
    const out = `${s.stdout}\n${s.stderr}`;
    const loggedIn = s.code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
    return { cli: "codex", installed: true, path: binPath, version, loggedIn, detail: out.trim().split("\n")[0] };
  },

  async prepare(input: PrepareInput): Promise<PreparedCommand> {
    const { assignment, workdir, isolation } = input;
    const stateDir = paths.cliState("codex", assignment.workspace.id, assignment.agent.id);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const userAuth = path.join(userCodexHome(), "auth.json");
    await linkAuth(stateDir, userAuth, false);

    // Sem seguir links que o agente tenha deixado na pasta (ex.: AGENTS.md -> ~/.bashrc).
    await safeWriteFile(workdir, path.join(workdir, "AGENTS.md"), input.systemPrompt);

    const env: Record<string, string> = { ...input.baseEnv, ...input.mcpEnv, CODEX_HOME: stateDir };
    const passthrough = Object.keys(input.mcpEnv);
    const cfg: string[] = [
      `mcp_servers.puxibot.command=${toml(input.mcp.command)}`,
      `mcp_servers.puxibot.args=${toml(input.mcp.args)}`,
      // [SUPOSIÇÃO] env_vars repassa estas variáveis do ambiente do Codex ao servidor.
      `mcp_servers.puxibot.env_vars=${toml(passthrough)}`,
    ];
    let i = 0;
    assignment.connectors.forEach((c, idx) => {
      const srv = connectorServer(c, input.mcpProxy, idx);
      if (!srv) return;
      const name = connectorServerName(c.name, c.id).replace(/-/g, "_");
      if (srv.transport === "http") {
        cfg.push(`mcp_servers.${name}.url=${toml(srv.url)}`);
        // [SUPOSIÇÃO] env_http_headers: cabeçalho -> nome da variável com o valor.
        const hdr: Record<string, string> = {};
        for (const [h, val] of Object.entries(srv.headers)) {
          const varName = `PUXIBOT_CONN_${i++}`;
          env[varName] = val;
          hdr[h] = varName;
        }
        if (Object.keys(hdr).length) cfg.push(`mcp_servers.${name}.env_http_headers=${toml(hdr)}`);
      } else if (Object.keys(srv.env).length && input.mcpExec) {
        // As variáveis do conector nunca entram no ambiente do Codex (nem do isolamento): vão
        // numa variável só, de nome fixo, lida pelo `puxibot mcp-exec`, que inicia o conector.
        const varName = `PUXIBOT_CONN_CFG_${idx}`;
        env[varName] = JSON.stringify({ command: srv.command, args: srv.args, env: srv.env });
        cfg.push(
          `mcp_servers.${name}.command=${toml(input.mcpExec.command)}`,
          `mcp_servers.${name}.args=${toml([...input.mcpExec.args, "--config-env", varName])}`,
          `mcp_servers.${name}.env_vars=${toml([varName])}`,
        );
      } else {
        cfg.push(`mcp_servers.${name}.command=${toml(srv.command)}`, `mcp_servers.${name}.args=${toml(srv.args)}`);
      }
    });

    const common = ["--json", "--skip-git-repo-check"];
    if (input.model) common.push("-m", input.model);
    if (isolation !== "none") {
      // O isolamento é do runner; o sandbox do Codex (Landlock/bwrap) ficaria aninhado.
      common.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      common.push("-s", "workspace-write", "-c", 'approval_policy="never"');
    }
    for (const c of cfg) common.push("-c", c);

    const args = input.resumeSessionId
      ? // [SUPOSIÇÃO] `exec resume` aceita --json/-m/-c e usa o cwd do processo.
        ["exec", "resume", input.resumeSessionId, ...common, "-"]
      : ["exec", "-C", workdir, ...common, "-"];

    return {
      command: isolation === "container" ? "codex" : input.binPath,
      args,
      env,
      stdin: input.userPrompt,
      // [SUPOSIÇÃO] o Codex grava auth.json ao renovar o token; por isso fica com escrita.
      credentials: existsSync(userAuth) ? [{ path: userAuth, writable: true, reason: "renovação de token" }] : [],
      writable: [stateDir],
      readable: [input.runDir],
      // O login fica com escrita em todo job do Codex; por isso pode ser copiado de volta.
      afterRun: async () => {
        await linkAuth(stateDir, userAuth, existsSync(userAuth));
      },
    };
  },

  createParser(ctx): StreamParser {
    return new CodexStreamParser(ctx.model);
  },
};

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string; command?: string; server?: string; tool?: string; arguments?: unknown };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
  message?: string;
  model?: string;
}

/** [SUPOSIÇÃO] formato do `codex exec --json`: thread.started, item.*, turn.completed/failed, error. */
export class CodexStreamParser implements StreamParser {
  private sessionId: string | null = null;
  private texts: string[] = [];
  private input = 0;
  private output = 0;
  private errors: string[] = [];
  private failed = false;
  private seenItems = new Set<string>();

  constructor(private model: string | null) {}

  line(raw: string): AdapterEvent[] {
    let j: CodexLine;
    try {
      j = JSON.parse(raw.trim()) as CodexLine;
    } catch {
      return [];
    }
    const out: AdapterEvent[] = [];
    switch (j.type) {
      case "thread.started":
        if (j.thread_id) {
          this.sessionId = j.thread_id;
          out.push({ type: "session", id: j.thread_id });
        }
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const it = j.item;
        if (!it) break;
        const key = `${it.id ?? ""}:${it.type ?? ""}`;
        if (it.type === "agent_message" && j.type === "item.completed" && it.text) {
          out.push({ type: "text", delta: (this.texts.length ? "\n\n" : "") + it.text });
          this.texts.push(it.text);
        } else if (it.type === "mcp_tool_call" && !this.seenItems.has(key)) {
          this.seenItems.add(key);
          const name = it.server === "puxibot" ? (it.tool ?? "mcp") : `${it.server}/${it.tool}`;
          const args = summarizeToolInput(it.arguments);
          out.push({ type: "tool", name, summary: args ? `${name} (${args})` : name });
        } else if (it.type === "command_execution" && !this.seenItems.has(key)) {
          this.seenItems.add(key);
          out.push({ type: "tool", name: "shell", summary: `shell (${(it.command ?? "").slice(0, 60)})` });
        }
        break;
      }
      case "turn.completed":
        // [SUPOSIÇÃO] input_tokens já inclui cached_input_tokens.
        this.input += j.usage?.input_tokens ?? 0;
        this.output += j.usage?.output_tokens ?? 0;
        break;
      case "turn.failed":
        this.failed = true;
        this.errors.push(typeof j.error === "string" ? j.error : (j.error?.message ?? "turno falhou"));
        break;
      case "error":
        this.errors.push(j.message ?? (typeof j.error === "string" ? j.error : (j.error?.message ?? "erro")));
        break;
    }
    return out;
  }

  finish(exit: { code: number | null; signal: NodeJS.Signals | null }, stderr: string): AdapterResult {
    const base = { inputTokens: this.input, outputTokens: this.output, model: this.model, sessionId: this.sessionId };
    if (!this.failed && exit.code === 0) {
      return { ok: true, text: (this.texts.at(-1) ?? "").trim(), ...base };
    }
    const msg = [...this.errors, stderr.trim().split("\n").slice(-6).join("\n")].filter(Boolean).join("\n");
    if (/no (rollout|session|thread) found|not found.*(session|thread)/i.test(msg)) {
      return { ok: false, text: "", ...base, errorCode: "error", error: "sessão anterior não encontrada", resumeFailed: true };
    }
    return {
      ok: false,
      text: "",
      ...base,
      errorCode: classifyError(msg) ?? "error",
      error: (msg || `o Codex terminou com código ${exit.code ?? exit.signal}`).slice(0, 2000),
    };
  }
}
