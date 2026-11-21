/**
 * `puxibot mcp-proxy`: intermediário MCP para conectores liberados como "somente leitura".
 *
 * A CLI de IA fala com este servidor (stdio) em vez de falar direto com o conector. Ele
 * se conecta ao conector de verdade (HTTP ou stdio), lista as ferramentas e só expõe as
 * que o próprio servidor marca com `annotations.readOnlyHint: true`. Chamadas a qualquer
 * outra ferramenta são recusadas aqui, sem chegar ao conector.
 *
 * Limites (também mostrados no `puxibot doctor`):
 *  - depende de o servidor do conector marcar corretamente `readOnlyHint` (a especificação
 *    do MCP diz que anotações são dicas). Ferramenta sem a marca é bloqueada;
 *  - só filtra ferramentas: recursos e prompts do conector não são repassados;
 *  - o segredo do conector precisa estar dentro do isolamento (o intermediário roda lá).
 *    Um agente que use o shell de propósito para chamar o conector direto não é impedido.
 *    Isto evita que o agente altere dados pelo caminho normal (as ferramentas MCP), não é
 *    uma barreira contra um agente malicioso.
 *
 * Configuração: JSON na variável de ambiente indicada por `--config-env <NOME>`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { filterConnectorEnv } from "../adapters/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ProxyUpstream {
  name: string;
  transport: "http" | "stdio";
  url?: string | null;
  headers?: Record<string, string>;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
}

/** Só ferramentas que o servidor declara que não alteram nada. */
export function isReadOnlyTool(t: Pick<Tool, "annotations">): boolean {
  return t.annotations?.readOnlyHint === true;
}

async function listAll(upstream: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await upstream.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/**
 * Servidor MCP que repassa ao `upstream` só as ferramentas somente leitura. Recebe o
 * cliente já conectado (testável com transportes em memória).
 */
export async function createReadOnlyProxy(upstream: Client, connectorName: string): Promise<Server> {
  let tools = await listAll(upstream);
  let allowed = new Map(tools.filter(isReadOnlyTool).map((t) => [t.name, t]));
  const blocked = tools.filter((t) => !isReadOnlyTool(t)).map((t) => t.name);

  const server = new Server(
    { name: `${connectorName}-somente-leitura`, version: "0.1.1" },
    {
      capabilities: { tools: {} },
      instructions:
        `Conector "${connectorName}" liberado somente para leitura. Só aparecem as ferramentas que o servidor marca como somente leitura` +
        (blocked.length ? `; ${blocked.length} ferramenta(s) que podem alterar dados foram bloqueadas (${blocked.slice(0, 20).join(", ")}).` : "."),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    tools = await listAll(upstream);
    allowed = new Map(tools.filter(isReadOnlyTool).map((t) => [t.name, t]));
    return { tools: [...allowed.values()] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!allowed.has(name)) {
      // A lista pode ter mudado desde a última consulta: confere de novo antes de recusar.
      tools = await listAll(upstream);
      allowed = new Map(tools.filter(isReadOnlyTool).map((t) => [t.name, t]));
    }
    if (!allowed.has(name)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `A ferramenta "${name}" do conector "${connectorName}" foi bloqueada: este agente tem acesso somente leitura a esse conector e o servidor não marca essa ferramenta como somente leitura. Explique isso na resposta; quem pode liberar escrita é o responsável pelo agente ou um admin.`,
          },
        ],
      };
    }
    const result = await upstream.callTool({ name, arguments: req.params.arguments ?? {} }, undefined, { timeout: 30 * 60_000 });
    return result as Record<string, unknown> & { content: unknown[] };
  });

  return server;
}

/** Ambiente para o conector stdio: o do processo, sem variáveis do Puxibot (token do job). */
function upstreamEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("PUXIBOT_")) continue;
    out[k] = v;
  }
  // Nomes perigosos (PATH, LD_*, NODE_OPTIONS...) vindos do hub não valem.
  return { ...out, ...filterConnectorEnv(extra).env };
}

export async function connectUpstream(cfg: ProxyUpstream): Promise<Client> {
  const client = new Client({ name: "puxibot-mcp-proxy", version: "0.1.1" });
  if (cfg.transport === "http") {
    if (!cfg.url) throw new Error("conector HTTP sem url");
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} } }));
  } else {
    if (!cfg.command) throw new Error("conector stdio sem comando");
    await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: upstreamEnv(cfg.env ?? {}), stderr: "inherit" }));
  }
  return client;
}

export async function runReadOnlyProxy(configEnv: string): Promise<void> {
  const raw = process.env[configEnv];
  if (!raw) throw new Error(`variável ${configEnv} ausente (o \`puxibot mcp-proxy\` é iniciado pela CLI durante um job)`);
  const cfg = JSON.parse(raw) as ProxyUpstream;
  // O segredo não fica no ambiente de processos que o conector stdio iniciar.
  delete process.env[configEnv];
  const upstream = await connectUpstream(cfg);
  const server = await createReadOnlyProxy(upstream, cfg.name);
  server.onclose = () => void upstream.close();
  await server.connect(new StdioServerTransport());
}
