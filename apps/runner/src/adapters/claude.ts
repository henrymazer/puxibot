/**
 * Adaptador do Claude Code. Verificado de verdade (Claude Code 2.1.x, Linux/WSL2).
 *
 * Linha de comando (conferida em `claude --help`):
 *   claude -p --output-format stream-json --verbose --include-partial-messages
 *          --append-system-prompt-file <arquivo> --system-prompt-snapshot off
 *          --mcp-config <arquivo> --strict-mcp-config --settings <json>
 *          --permission-mode <modo> [--model m] [--resume <id>]   (prompt pelo stdin)
 *
 * Estado: `CLAUDE_CONFIG_DIR` aponta para ~/.puxibot/cli-state/claude/<ws>/<agente>, separado da
 * configuração da pessoa e da dos outros agentes (hooks, plugins e MCPs dela não vazam para o agente). As
 * credenciais (`.credentials.json`) são um link simbólico para as da pessoa.
 *
 * macOS (NÃO TESTADO): lá o login fica no Keychain e, pelo que sabemos, o nome do
 * item depende da pasta de configuração; por isso no macOS o adaptador não troca
 * `CLAUDE_CONFIG_DIR` e usa ~/.claude.
 */
import { promises as fs, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobErrorCode } from "@puxibot/shared";
import { paths } from "../config.js";
import { run } from "../proc.js";
import { isClaudeCredentials, syncCredentialLink, type CredentialSyncResult } from "./credentials.js";
import {
  classifyError,
  connectorServer,
  friendlyToolName,
  summarizeToolInput,
  type AdapterEvent,
  type AdapterResult,
  type CliAdapter,
  type CliStatus,
  type CredentialMount,
  type PrepareInput,
  type PreparedCommand,
  type StreamParser,
} from "./types.js";

/** Pasta de configuração da própria pessoa (onde está o login dela). */
export function userClaudeDir(): string {
  return process.env.PUXIBOT_USER_CLAUDE_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/** Margem: se o token de acesso vence antes do fim do job + isso, liberamos escrita. */
const CREDENTIAL_MARGIN_MS = 10 * 60_000;

function readExpiresAt(file: string): number | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { expiresAt?: number } };
    return typeof j.claudeAiOauth?.expiresAt === "number" ? j.claudeAiOauth.expiresAt : null;
  } catch {
    return null;
  }
}

/**
 * Garante `<state>/.credentials.json -> <usuário>/.credentials.json`. Se a CLI substituiu o
 * link por um arquivo (ao renovar o token), copia o mais novo de volta para a pasta da pessoa
 * antes de refazer o link, para não perder a rotação do refresh token — mas só com
 * `copyBack` (o login estava montado com escrita neste job) e só se o arquivo for um login
 * válido do Claude Code. Fora disso o arquivo é descartado (ver adapters/credentials.ts).
 */
export async function syncClaudeCredentials(stateDir: string, userDir = userClaudeDir(), copyBack = false): Promise<CredentialSyncResult> {
  return syncCredentialLink({
    stateRoot: stateDir,
    stateFile: path.join(stateDir, ".credentials.json"),
    userFile: path.join(userDir, ".credentials.json"),
    copyBack,
    validate: isClaudeCredentials,
    newer: (state, user) => (readExpires(state) ?? 0) > (readExpires(user) ?? 0),
  });
}

function readExpires(j: unknown): number | null {
  const e = (j as { claudeAiOauth?: { expiresAt?: unknown } } | null)?.claudeAiOauth?.expiresAt;
  return typeof e === "number" ? e : null;
}

export const claudeAdapter: CliAdapter = {
  cli: "claude",
  displayName: "Claude Code",
  binName: "claude",
  npmPackage: "@anthropic-ai/claude-code",
  verified: true,
  skillsDir: ".claude/skills",
  utilityModel: "haiku",

  async detect(binPath): Promise<CliStatus> {
    if (!binPath) return { cli: "claude", installed: false, path: null, version: null, loggedIn: null };
    const v = await run(binPath, ["--version"], { timeoutMs: 15_000 });
    const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
    // `claude auth status` só lê o login local; não gasta uso.
    const s = await run(binPath, ["auth", "status"], { timeoutMs: 15_000 });
    let loggedIn: boolean | null = null;
    let detail: string | undefined;
    try {
      const j = JSON.parse(s.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      loggedIn = j.loggedIn ?? null;
      detail = [j.authMethod, j.subscriptionType].filter(Boolean).join(", ") || undefined;
    } catch {
      loggedIn = s.code === 0 ? null : false;
    }
    return { cli: "claude", installed: true, path: binPath, version, loggedIn, detail };
  },

  async prepare(input: PrepareInput): Promise<PreparedCommand> {
    const { assignment, runDir, isolation } = input;
    const isMac = process.platform === "darwin";
    const stateDir = paths.cliState("claude", assignment.workspace.id, assignment.agent.id);
    const utility = input.utility === true;
    // Chamada utilitária: sem servidor MCP, então o token do trabalho nem entra no ambiente.
    const env: Record<string, string> = utility ? { ...input.baseEnv } : { ...input.baseEnv, ...input.mcpEnv };
    const credentials: CredentialMount[] = [];
    const writable: string[] = [];
    let afterRun: (() => Promise<void>) | undefined;

    if (!isMac) {
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      // Antes do job: um arquivo deixado no lugar do link nunca é copiado de volta.
      await syncClaudeCredentials(stateDir, userClaudeDir(), false);
      env.CLAUDE_CONFIG_DIR = stateDir;
      writable.push(stateDir);
      const userFile = path.join(userClaudeDir(), ".credentials.json");
      let needsRefresh = false;
      if (existsSync(userFile)) {
        const exp = readExpiresAt(userFile);
        const deadline = Date.now() + assignment.timeoutMs + CREDENTIAL_MARGIN_MS;
        needsRefresh = exp === null || exp < deadline;
        credentials.push({
          path: userFile,
          writable: needsRefresh,
          reason: needsRefresh ? "token de acesso vence durante o job; a CLI precisa gravar o token renovado" : undefined,
        });
      }
      afterRun = async () => {
        await syncClaudeCredentials(stateDir, userClaudeDir(), needsRefresh);
      };
    } else {
      // NÃO TESTADO: macOS usa ~/.claude e o Keychain.
      writable.push(userClaudeDir(), path.join(os.homedir(), ".claude.json"));
    }

    if (isolation === "container") {
      // O Claude Code recusa /tmp/claude-<uid> se o dono for outro (o Docker cria como
      // root as pastas-pai das montagens). Usa uma pasta temporária do próprio job.
      const tmp = path.join(runDir, "tmp");
      await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
      env.CLAUDE_CODE_TMPDIR = tmp;
      writable.push(tmp);
    }

    // Prompt de sistema adicional em arquivo (evita limite de tamanho de argv).
    const systemFile = path.join(runDir, utility ? "utility-system-prompt.md" : "system-prompt.md");
    await fs.writeFile(systemFile, input.systemPrompt, { mode: 0o600 });

    // Configuração MCP. O token do job não entra no arquivo: o Claude Code repassa
    // o próprio ambiente aos servidores stdio, e PUXIBOT_JOB_TOKEN está nele.
    const servers: Record<string, unknown> = utility
      ? {}
      : { puxibot: { type: "stdio", command: input.mcp.command, args: input.mcp.args, env: {} } };
    const allowedMcp = ["mcp__puxibot"];
    assignment.connectors.forEach((c, i) => {
      const srv = connectorServer(c, input.mcpProxy, i);
      if (!srv) return;
      const name = connectorServerName(c.name, c.id);
      servers[name] = srv.transport === "http" ? { type: "http", url: srv.url, headers: srv.headers } : { type: "stdio", command: srv.command, args: srv.args, env: srv.env };
      allowedMcp.push(`mcp__${name}`);
    });
    // Contém segredos de conectores: 0600, na pasta do job, apagado ao terminar.
    const mcpFile = path.join(runDir, utility ? "utility-mcp.json" : "mcp.json");
    await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });

    const isolated = isolation !== "none";
    const settings = {
      // O isolamento é do runner; o sandbox próprio do Claude Code ficaria aninhado.
      sandbox: { enabled: false },
      // Sem hooks nem atualização automática dentro de um job.
      disableAllHooks: true,
    };

    const args = [
      "-p",
      // Só as ferramentas nativas que um agente do Puxibot usa. O conjunto padrão do Claude Code
      // custa bem mais contexto a cada ida ao modelo e ainda adia as ferramentas do Puxibot para uma
      // busca (uma ida a mais). Medido com haiku: um trabalho com uma ferramenta caiu de ~69 mil
      // para ~33 mil tokens de entrada.
      "--tools",
      utility ? "" : claudeTools().join(","),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Utilitária: o prompt substitui as instruções do Claude Code (chamada de ~1 mil tokens).
      utility ? "--system-prompt-file" : "--append-system-prompt-file",
      systemFile,
      "--system-prompt-snapshot",
      "off",
      "--mcp-config",
      mcpFile,
      "--strict-mcp-config",
      "--settings",
      JSON.stringify(settings),
    ];
    if (isolated) {
      // Dentro do isolamento do runner o agente age sem pedir permissão.
      args.push("--permission-mode", "bypassPermissions");
    } else {
      // Sem isolamento: só edições na pasta de trabalho e as ferramentas MCP liberadas;
      // nada de shell.
      args.push("--permission-mode", "acceptEdits", "--allowedTools", allowedMcp.join(","), "--disallowedTools", "Bash");
    }
    if (input.model) args.push("--model", input.model);
    if (input.resumeSessionId && !utility) args.push("--resume", input.resumeSessionId);

    return {
      command: isolation === "container" ? "claude" : input.binPath,
      args,
      env,
      stdin: input.userPrompt,
      credentials,
      writable,
      readable: [runDir],
      afterRun,
    };
  },

  createParser(): StreamParser {
    return new ClaudeStreamParser();
  },
};

/** Ferramentas nativas do Claude Code liberadas aos agentes (as do Puxibot e dos conectores vêm por MCP). */
export const CLAUDE_DEFAULT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"];

/** PUXIBOT_CLAUDE_TOOLS troca a lista (nomes separados por vírgula; `default` = todas as do Claude Code). */
export function claudeTools(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.PUXIBOT_CLAUDE_TOOLS ?? "").trim();
  if (!raw) return CLAUDE_DEFAULT_TOOLS;
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

export function connectorServerName(name: string, id: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const n = base || `conector-${id.slice(0, 8)}`;
  return n === "puxibot" ? `${n}-${id.slice(0, 6)}` : n;
}

interface ClaudeLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  error?: string;
  event?: {
    type?: string;
    message?: { id?: string; model?: string };
    content_block?: { type?: string };
    delta?: { type?: string; text?: string };
  };
  message?: {
    id?: string;
    model?: string;
    content?: { type?: string; text?: string; name?: string; input?: unknown }[];
  };
  rate_limit_info?: { status?: string; rateLimitType?: string };
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
  errors?: string[];
}

export class ClaudeStreamParser implements StreamParser {
  private sessionId: string | null = null;
  private model: string | null = null;
  private resultLine: ClaudeLine | null = null;
  private apiError: string | null = null;
  private rateLimited = false;
  private streamedMessages = new Set<string>();
  private currentMessageId: string | null = null;
  private emittedText = false;
  private lastAssistantText = "";

  line(raw: string): AdapterEvent[] {
    const s = raw.trim();
    if (!s.startsWith("{")) return [];
    let j: ClaudeLine;
    try {
      j = JSON.parse(s) as ClaudeLine;
    } catch {
      return [];
    }
    const out: AdapterEvent[] = [];
    if (j.session_id && j.session_id !== this.sessionId) {
      this.sessionId = j.session_id;
      out.push({ type: "session", id: j.session_id });
    }
    // Saída de subagentes não entra no texto da resposta.
    const topLevel = !j.parent_tool_use_id;
    switch (j.type) {
      case "system":
        if (j.subtype === "init" && j.model) this.setModel(j.model, out);
        break;
      case "stream_event": {
        const ev = j.event;
        if (!ev || !topLevel) break;
        if (ev.type === "message_start") {
          this.currentMessageId = ev.message?.id ?? null;
          if (ev.message?.model) this.setModel(ev.message.model, out);
        } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
          if (this.emittedText) out.push({ type: "text", delta: "\n\n" });
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          if (this.currentMessageId) this.streamedMessages.add(this.currentMessageId);
          this.emittedText = true;
          out.push({ type: "text", delta: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        if (j.error) this.apiError = j.error;
        const msg = j.message;
        if (!msg) break;
        if (msg.model && msg.model !== "<synthetic>") this.setModel(msg.model, out);
        const streamed = msg.id ? this.streamedMessages.has(msg.id) : false;
        for (const block of msg.content ?? []) {
          if (block.type === "tool_use" && block.name) {
            const name = friendlyToolName(block.name);
            const args = summarizeToolInput(block.input);
            out.push({ type: "tool", name, summary: args ? `${name} (${args})` : name });
          } else if (block.type === "text" && block.text && topLevel) {
            this.lastAssistantText = block.text;
            if (!streamed && !j.error) {
              out.push({ type: "text", delta: (this.emittedText ? "\n\n" : "") + block.text });
              this.emittedText = true;
            }
          }
        }
        break;
      }
      case "rate_limit_event":
        if (j.rate_limit_info?.status === "rejected") this.rateLimited = true;
        break;
      case "result":
        this.resultLine = j;
        break;
    }
    return out;
  }

  private setModel(model: string, out: AdapterEvent[]): void {
    if (model === "<synthetic>" || model === this.model) return;
    this.model = model;
    out.push({ type: "model", model });
  }

  finish(exit: { code: number | null; signal: NodeJS.Signals | null }, stderr: string): AdapterResult {
    const r = this.resultLine;
    let inputTokens = 0;
    let outputTokens = 0;
    let model = this.model;
    // Conta entrada total: nova + lida do cache + gravada no cache.
    // `usage` é só desta execução. `modelUsage` soma a sessão inteira quando há --resume (conferido
    // com a CLI real), então só serve para escolher o modelo e como reserva se `usage` não vier.
    let sumIn = 0;
    let sumOut = 0;
    let best = -1;
    for (const [m, u] of Object.entries(r?.modelUsage ?? {})) {
      sumIn += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
      sumOut += u.outputTokens ?? 0;
      if ((u.outputTokens ?? 0) > best) {
        best = u.outputTokens ?? 0;
        model = m;
      }
    }
    if (r?.usage) {
      inputTokens = (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
      outputTokens = r.usage.output_tokens ?? 0;
    } else {
      inputTokens = sumIn;
      outputTokens = sumOut;
    }
    const base = { inputTokens, outputTokens, model, sessionId: this.sessionId };

    if (r && !r.is_error && r.subtype === "success") {
      return { ok: true, text: (r.result ?? this.lastAssistantText).trim(), ...base };
    }
    const message = [r?.result, ...(r?.errors ?? []), r ? "" : stderr].filter(Boolean).join("\n").trim();
    if (/no conversation found|session .* not found/i.test(message + "\n" + stderr)) {
      return { ok: false, text: "", ...base, errorCode: "error", error: "sessão anterior não encontrada", resumeFailed: true };
    }
    let errorCode: JobErrorCode = "error";
    if (this.apiError === "authentication_failed" || this.apiError === "oauth_org_not_allowed") errorCode = "auth";
    else if (this.apiError === "rate_limit" || this.apiError === "billing_error" || this.rateLimited) errorCode = "limit";
    else errorCode = classifyError(message + "\n" + stderr) ?? "error";
    const fallback =
      exit.signal ? `o Claude Code foi encerrado (${exit.signal})` : `o Claude Code terminou com código ${exit.code ?? "?"}`;
    return { ok: false, text: "", ...base, errorCode, error: (message || lastLines(stderr) || fallback).slice(0, 2000) };
  }
}

function lastLines(s: string, n = 8): string {
  return s.trim().split("\n").slice(-n).join("\n");
}
