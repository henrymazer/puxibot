/**
 * Adaptador do Gemini CLI.
 *
 * ATENÇÃO: NÃO VERIFICADO COM EXECUÇÃO REAL. Montado a partir de `gemini --help`
 * (0.55), da documentação embutida no pacote (docs/cli/headless.md,
 * session-management.md, skills.md, reference/configuration.md) e do código do
 * formatador `stream-json`. Suposições marcadas com [SUPOSIÇÃO].
 *
 * Linha de comando:
 *   gemini -p <instrução curta> --output-format stream-json --skip-trust
 *          --approval-mode <yolo|auto_edit> [-m modelo]
 *          [--resume <uuid> | --session-id <uuid>]          (pedido pelo stdin)
 *
 * Instruções do agente: GEMINI.md na pasta de trabalho. MCP: .gemini/settings.json
 * da pasta de trabalho. Estado: GEMINI_CLI_HOME = ~/.puxibot/cli-state/gemini/<ws>/<agente>, com
 * as credenciais OAuth ligadas às da pessoa.
 */
import { randomUUID } from "node:crypto";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../config.js";
import { run } from "../proc.js";
import { safeMkdir, safeWriteFile } from "../safefs.js";
import { connectorServerName } from "./claude.js";
import { isGeminiAccounts, isGeminiOauth, syncCredentialLink } from "./credentials.js";
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

export function userGeminiDir(): string {
  const home = process.env.PUXIBOT_USER_GEMINI_HOME ?? process.env.GEMINI_CLI_HOME ?? os.homedir();
  return path.join(home, ".gemini");
}

const CREDENTIAL_FILES = ["oauth_creds.json", "google_accounts.json"];

export const geminiAdapter: CliAdapter = {
  cli: "gemini",
  displayName: "Gemini CLI",
  binName: "gemini",
  npmPackage: "@google/gemini-cli",
  verified: false,
  // Documentado: `.agents/skills/` é alias de `.gemini/skills/` no workspace.
  skillsDir: ".agents/skills",
  // Documentado em docs/runner.md (login por chave de API) e lido pelo detect.
  authEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],

  async detect(binPath): Promise<CliStatus> {
    if (!binPath) return { cli: "gemini", installed: false, path: null, version: null, loggedIn: null };
    const v = await run(binPath, ["--version"], { timeoutMs: 20_000 });
    const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
    // Sem comando de status de login: olhamos credenciais e variáveis conhecidas.
    let loggedIn: boolean | null = false;
    let detail = "sem credenciais encontradas (rode `gemini` uma vez para entrar)";
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      loggedIn = true;
      detail = "chave de API no ambiente";
    } else if (process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      loggedIn = null;
      detail = "Vertex AI configurado (não verificado)";
    } else if (existsSync(path.join(userGeminiDir(), "oauth_creds.json"))) {
      loggedIn = true;
      detail = "login com Google";
    }
    return { cli: "gemini", installed: true, path: binPath, version, loggedIn, detail };
  },

  async prepare(input: PrepareInput): Promise<PreparedCommand> {
    const { assignment, workdir, isolation } = input;
    const stateHome = paths.cliState("gemini", assignment.workspace.id, assignment.agent.id);
    const stateGemini = path.join(stateHome, ".gemini");
    await fs.mkdir(stateHome, { recursive: true, mode: 0o700 });
    await safeMkdir(stateHome, stateGemini);
    const credentials: CredentialMount[] = [];
    for (const f of CREDENTIAL_FILES) {
      const target = path.join(userGeminiDir(), f);
      await linkCred(stateHome, f, false);
      // [SUPOSIÇÃO] o Gemini CLI regrava oauth_creds.json ao renovar o token.
      if (existsSync(target)) credentials.push({ path: target, writable: true, reason: "renovação de token" });
    }
    // Leva o tipo de login escolhido pela pessoa para as configurações isoladas.
    const userSettings = readJson(path.join(userGeminiDir(), "settings.json"));
    const selectedType = (userSettings?.security as { auth?: { selectedType?: string } } | undefined)?.auth?.selectedType;
    await safeWriteFile(
      stateHome,
      path.join(stateGemini, "settings.json"),
      JSON.stringify(
        {
          ...(selectedType ? { security: { auth: { selectedType } } } : {}),
          // [SUPOSIÇÃO] chaves de configuração para não pedir confiança da pasta e não abrir sandbox próprio.
          tools: { sandbox: false },
          privacy: { usageStatisticsEnabled: false },
        },
        null,
        2,
      ),
    );

    // Sem seguir links que o agente tenha deixado na pasta de trabalho.
    await safeWriteFile(workdir, path.join(workdir, "GEMINI.md"), input.systemPrompt);

    // MCP no settings.json da pasta de trabalho. Segredos via "$VARIAVEL" (o Gemini
    // expande variáveis de ambiente nas configurações), nunca gravados em disco.
    const env: Record<string, string> = { ...input.baseEnv, ...input.mcpEnv, GEMINI_CLI_HOME: stateHome };
    const mcpEnvRefs: Record<string, string> = {};
    for (const k of Object.keys(input.mcpEnv)) mcpEnvRefs[k] = `$${k}`;
    const servers: Record<string, unknown> = {
      puxibot: { command: input.mcp.command, args: input.mcp.args, env: mcpEnvRefs, trust: true },
    };
    let i = 0;
    assignment.connectors.forEach((c, idx) => {
      const srv = connectorServer(c, input.mcpProxy, idx);
      if (!srv) return;
      const name = connectorServerName(c.name, c.id); // sem "_" (recomendação da documentação)
      const refs = (o: Record<string, string>) => {
        const r: Record<string, string> = {};
        for (const [k, v] of Object.entries(o)) {
          const varName = `PUXIBOT_CONN_${i++}`;
          env[varName] = v;
          r[k] = `$${varName}`;
        }
        return r;
      };
      if (srv.transport === "http") servers[name] = { httpUrl: srv.url, headers: refs(srv.headers), trust: true };
      else servers[name] = { command: srv.command, args: srv.args, env: refs(srv.env), trust: true };
    });
    await safeWriteFile(workdir, path.join(workdir, ".gemini", "settings.json"), JSON.stringify({ mcpServers: servers }, null, 2));

    const args = [
      "-p",
      "Responda ao pedido acima seguindo as instruções do GEMINI.md.",
      "--output-format",
      "stream-json",
      "--skip-trust",
      "--approval-mode",
      isolation === "none" ? "auto_edit" : "yolo",
    ];
    if (input.model) args.push("-m", input.model);
    if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
    else args.push("--session-id", randomUUID());

    return {
      command: isolation === "container" ? "gemini" : input.binPath,
      args,
      env,
      stdin: input.userPrompt,
      credentials,
      writable: [stateHome],
      readable: [input.runDir],
      afterRun: async () => {
        // O login fica com escrita em todo job do Gemini; por isso pode ser copiado de volta.
        for (const f of CREDENTIAL_FILES) await linkCred(stateHome, f, existsSync(path.join(userGeminiDir(), f)));
      },
    };
  },

  createParser(ctx): StreamParser {
    return new GeminiStreamParser(ctx.model);
  },
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Link de um arquivo de login no estado do agente (cópia de volta só com `copyBack`). */
function linkCred(stateHome: string, file: string, copyBack: boolean) {
  return syncCredentialLink({
    stateRoot: stateHome,
    stateFile: path.join(stateHome, ".gemini", file),
    userFile: path.join(userGeminiDir(), file),
    copyBack,
    validate: file === "oauth_creds.json" ? isGeminiOauth : isGeminiAccounts,
  });
}

interface GeminiLine {
  type?: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  parameters?: unknown;
  status?: string;
  message?: string;
  error?: { type?: string; message?: string };
  stats?: { input_tokens?: number; output_tokens?: number; models?: Record<string, unknown> };
}

/** Formato conferido no código do Gemini CLI 0.55 (StreamJsonFormatter); não executado. */
export class GeminiStreamParser implements StreamParser {
  private sessionId: string | null = null;
  private text = "";
  private result: GeminiLine | null = null;
  private errors: string[] = [];

  constructor(private model: string | null) {}

  line(raw: string): AdapterEvent[] {
    let j: GeminiLine;
    try {
      j = JSON.parse(raw.trim()) as GeminiLine;
    } catch {
      return [];
    }
    const out: AdapterEvent[] = [];
    switch (j.type) {
      case "init":
        if (j.session_id) {
          this.sessionId = j.session_id;
          out.push({ type: "session", id: j.session_id });
        }
        if (j.model) {
          this.model = j.model;
          out.push({ type: "model", model: j.model });
        }
        break;
      case "message":
        if (j.role === "assistant" && j.content) {
          this.text += j.content;
          out.push({ type: "text", delta: j.content });
        }
        break;
      case "tool_use":
        if (j.tool_name) {
          const name = friendlyToolName(j.tool_name);
          const args = summarizeToolInput(j.parameters);
          out.push({ type: "tool", name, summary: args ? `${name} (${args})` : name });
        }
        break;
      case "error":
        if (j.message) this.errors.push(j.message);
        break;
      case "result":
        this.result = j;
        if (j.error?.message) this.errors.push(j.error.message);
        break;
    }
    return out;
  }

  finish(exit: { code: number | null; signal: NodeJS.Signals | null }, stderr: string): AdapterResult {
    const stats = this.result?.stats;
    const models = stats?.models ? Object.keys(stats.models) : [];
    const base = {
      inputTokens: stats?.input_tokens ?? 0,
      outputTokens: stats?.output_tokens ?? 0,
      model: this.model ?? models[0] ?? null,
      sessionId: this.sessionId,
    };
    if (this.result?.status === "success" && exit.code === 0) return { ok: true, text: this.text.trim(), ...base };
    const msg = [...this.errors, stderr.trim().split("\n").slice(-6).join("\n")].filter(Boolean).join("\n");
    if (/session.*not found|invalid session|no session/i.test(msg)) {
      return { ok: false, text: "", ...base, errorCode: "error", error: "sessão anterior não encontrada", resumeFailed: true };
    }
    return {
      ok: false,
      text: "",
      ...base,
      errorCode: classifyError(msg) ?? "error",
      error: (msg || `o Gemini CLI terminou com código ${exit.code ?? exit.signal}`).slice(0, 2000),
    };
  }
}
