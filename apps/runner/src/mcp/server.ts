/**
 * `puxibot mcp`: servidor MCP por stdio com as ferramentas nativas do Puxibot.
 * Iniciado pela CLI de IA durante um job (não pela pessoa). Lê do ambiente:
 *   PUXIBOT_HUB_URL, PUXIBOT_JOB_TOKEN (obrigatórios)
 *   PUXIBOT_TOOL_PERMS (JSON), PUXIBOT_AGENT_IS_ASSISTANT ("1"/"0"), PUXIBOT_CHANNEL_ID
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redact } from "../log.js";
import { HubApi, HubApiError } from "./hubApi.js";
import { TOOLS, toolAllowed, type ToolContext, type ToolDef } from "./tools.js";

const MAX_RESULT_CHARS = 60_000;

export function errorMessageFor(t: ToolDef, e: unknown): string {
  if (e instanceof HubApiError) {
    if (e.status === 403) {
      return `Você não tem permissão para ${t.action}. ${e.message ? `O hub disse: ${e.message}. ` : ""}Explique isso na sua resposta; quem pode liberar é o responsável pelo agente ou um admin do workspace.`;
    }
    if (e.status === 401) return "O token deste trabalho expirou ou não é mais válido (o job pode ter sido cancelado). Termine a resposta sem usar mais ferramentas do Puxibot.";
    if (e.status === 404) return `Não encontrado: ${e.message}`;
    if (e.status === 409) return `Conflito: ${e.message}`;
    if (e.status === 400 || e.status === 422) return `Pedido inválido: ${e.message}`;
    return `O hub respondeu com erro ${e.status}: ${e.message}`;
  }
  return `Falha ao chamar o hub: ${redact(e instanceof Error ? e.message : String(e))}`;
}

function parsePerms(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

export function createPuxibotMcpServer(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): McpServer {
  const hubUrl = env.PUXIBOT_HUB_URL;
  const token = env.PUXIBOT_JOB_TOKEN;
  if (!hubUrl || !token) throw new Error("PUXIBOT_HUB_URL e PUXIBOT_JOB_TOKEN precisam estar no ambiente (o `puxibot mcp` é iniciado pela CLI durante um job).");
  const api = new HubApi(hubUrl, token);
  const perms = parsePerms(env.PUXIBOT_TOOL_PERMS);
  const isAssistant = env.PUXIBOT_AGENT_IS_ASSISTANT === undefined ? null : env.PUXIBOT_AGENT_IS_ASSISTANT === "1";
  const ctx: ToolContext = {
    channelId: env.PUXIBOT_CHANNEL_ID || null,
    cwd,
    call: (o) => api.json(o),
    raw: async (o) => {
      const r = await api.request(o);
      if (r.status < 200 || r.status >= 300) {
        let message = `HTTP ${r.status}`;
        try {
          message = (JSON.parse(r.body.toString("utf8")) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          /* corpo não JSON */
        }
        throw new HubApiError(r.status, null, message);
      }
      return r;
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  };

  const server = new McpServer(
    { name: "puxibot", version: "0.1.1" },
    {
      instructions:
        "Ferramentas nativas do Puxibot: mensagens, memória, tarefas, wiki, drive, time e aprovações do workspace. Sua resposta final já é publicada na conversa de origem; use enviar_mensagem só para outros destinos.",
    },
  );

  for (const t of TOOLS) {
    if (!toolAllowed(t, perms, isAssistant)) continue;
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input },
      async (args: Record<string, unknown>) => {
        try {
          const result = await t.run(args ?? {}, ctx);
          let text = result === null || result === undefined ? "ok" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
          if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + "\n…(resultado cortado)";
          return { content: [{ type: "text" as const, text }] };
        } catch (e) {
          return { content: [{ type: "text" as const, text: errorMessageFor(t, e) }], isError: true };
        }
      },
    );
  }
  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createPuxibotMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
