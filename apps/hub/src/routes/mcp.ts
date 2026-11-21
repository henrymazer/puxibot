/**
 * Servidor MCP do hub: `POST /api/workspaces/:ws/mcp` (Streamable HTTP, sem estado, respostas em JSON).
 * Autenticado como qualquer rota do workspace (token pessoal `Authorization: Bearer tb_...`); age com as
 * permissões da pessoa dona do token. JSON-RPC mínimo à mão: initialize, ping, tools/list, tools/call.
 */
import { Hono, type Context } from "hono";
import { z, type ZodTypeAny } from "zod";
import { handleSchema, TASK_PRIORITIES, TASK_STATUSES, type ActorRef } from "@puxibot/shared";
import { all, first } from "../lib/db";
import { HttpError } from "../lib/errors";
import { parseWith, readTextLimited } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { userActor } from "../domain/actor";
import { canTalkTo, createAgent, listAgents } from "../domain/agents";
import { findOrCreateDm, publishChannel, requireVisibleChannel } from "../domain/channels";
import { requireAgentByHandle, waitForJob } from "../domain/consult";
import { requestAgentWork } from "../domain/jobs";
import { insertMessage } from "../domain/messages";
import { assertRoutineChannel, assertValidSchedule, DEFAULT_TIMEZONE, insertRoutine } from "../domain/routines";
import { toRoutineDTO, type AgentRow } from "../domain/rows";
import { searchWorkspace } from "../domain/search";
import { createTask, listTasks } from "../domain/tasks";
import { findChannelByRef } from "../domain/visibility";

export const mcpRoutes = new Hono<WsEnv>();

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BATCH = 20;
const SERVER_INFO = { name: "puxibot-hub", version: "0.1.1" };

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schema: ZodTypeAny;
  run(c: Context<WsEnv>, args: any): Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const str = (description: string) => ({ type: "string", description });

const TOOLS: ToolSpec[] = [
  {
    name: "listar_agentes",
    description: "Lista os agentes do workspace (handle, nome, função, status e se você pode falar com ele).",
    inputSchema: { type: "object", properties: {} },
    schema: z.object({}).passthrough(),
    run: async (c) => {
      const db = c.env.DB;
      const userId = c.get("userId");
      const agents = await listAgents(db, c.get("wsId"));
      const rows = await all<AgentRow>(db, "SELECT * FROM agents WHERE workspace_id = ?", c.get("wsId"));
      const items = [];
      for (const a of agents) {
        if (a.isAssistant && a.ownerUserId !== userId) continue;
        const row = rows.find((r) => r.id === a.id);
        items.push({
          handle: a.handle,
          name: a.name,
          role: a.role,
          description: a.description,
          status: a.status,
          activity: a.activity,
          isAssistant: a.isAssistant,
          canTalk: row ? await canTalkTo(db, row, userId) : false,
        });
      }
      return { items };
    },
  },
  {
    name: "criar_agente",
    description: "Cria um agente no workspace. Você vira o responsável por ele.",
    inputSchema: {
      type: "object",
      properties: {
        handle: str("Handle único (minúsculas, números, - ou _), usado em @menções."),
        name: str("Nome de exibição."),
        role: str("Função (ex.: Engenharia, Marketing)."),
        description: str("Descrição curta."),
        instructions: str("Instruções do agente (prompt de sistema)."),
      },
      required: ["handle", "name"],
    },
    schema: z.object({
      handle: handleSchema,
      name: z.string().min(1).max(60),
      role: z.string().max(60).optional(),
      description: z.string().max(500).optional(),
      instructions: z.string().max(50_000).optional(),
    }),
    run: async (c, a) =>
      createAgent(c.get("hub"), {
        handle: a.handle,
        name: a.name,
        role: a.role ?? null,
        description: a.description ?? null,
        instructions: a.instructions ?? "",
        ownerUserId: c.get("userId"),
      }),
  },
  {
    name: "pedir_ao_agente",
    description:
      "Manda um pedido a um agente (na DM entre você e ele) e espera a resposta. Precisa de um runner online para executar.",
    inputSchema: {
      type: "object",
      properties: {
        handle: str("Handle do agente (sem @)."),
        prompt: str("O pedido."),
        aguardarSegundos: { type: "number", description: "Quanto esperar pela resposta (padrão 120, máx. 600)." },
      },
      required: ["handle", "prompt"],
    },
    schema: z.object({ handle: z.string().min(1), prompt: z.string().min(1).max(20_000), aguardarSegundos: z.number().min(1).max(600).optional() }),
    run: async (c, a) => {
      const db = c.env.DB;
      const hub = c.get("hub");
      const userId = c.get("userId");
      const agent = await requireAgentByHandle(db, c.get("wsId"), a.handle);
      if (!(await canTalkTo(db, agent, userId))) throw new HttpError(403, "agent_access_denied", `Você não tem permissão para falar com ${agent.name}.`);
      const { channel, created } = await findOrCreateDm(db, c.get("wsId"), { type: "user", id: userId }, { type: "agent", id: agent.id }, userId);
      if (created) await publishChannel(hub, channel);
      const message = await insertMessage(hub, { channel, author: { type: "user", id: userId }, body: a.prompt });
      const job = await requestAgentWork(hub, { agent, userId, channel, prompt: a.prompt, triggerMessageId: message.id, threadRootId: null });
      if (!job) return { status: "blocked", text: "", note: "O pedido foi bloqueado (agente pausado, sem permissão ou sem orçamento). Veja a mensagem na DM." };
      const result = await waitForJob(db, c.get("wsId"), job.id, { timeoutMs: (a.aguardarSegundos ?? 120) * 1000, intervalMs: 1000 });
      return {
        status: result.status,
        text: result.text,
        jobId: job.id,
        channelId: channel.id,
        ...(result.status === "timeout" ? { note: "Ainda sem resposta; ela vai aparecer na DM com o agente quando ficar pronta." } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
  },
  {
    name: "criar_rotina",
    description: "Cria uma rotina agendada (cron de 5 campos, no fuso informado) para um agente de que você é responsável.",
    inputSchema: {
      type: "object",
      properties: {
        agent: str("Handle do agente."),
        name: str("Nome da rotina."),
        prompt: str("O que o agente faz a cada execução."),
        cron: str("Expressão cron, ex.: '0 9 * * 1-5'."),
        timezone: str("Fuso IANA (padrão America/Sao_Paulo)."),
        channel: str("Canal (nome ou id) onde publicar o resultado; padrão: DM com o agente."),
      },
      required: ["agent", "name", "prompt", "cron"],
    },
    schema: z.object({
      agent: z.string().min(1),
      name: z.string().min(1).max(100),
      prompt: z.string().min(1).max(20_000),
      cron: z.string().min(1).max(120),
      timezone: z.string().max(64).optional(),
      channel: z.string().optional(),
    }),
    run: async (c, a) => {
      const db = c.env.DB;
      const wsId = c.get("wsId");
      const userId = c.get("userId");
      const agent = await requireAgentByHandle(db, wsId, a.agent);
      if (agent.owner_user_id !== userId && (!isAdmin(c) || agent.is_assistant === 1)) {
        throw new HttpError(403, "forbidden", "Só o responsável pelo agente (ou um admin, exceto para assistente pessoal) cria rotinas para ele.");
      }
      const timezone = a.timezone?.trim() || DEFAULT_TIMEZONE;
      assertValidSchedule(a.cron, timezone);
      let channelId: string;
      if (a.channel) {
        const ch = await findChannelByRef(db, wsId, a.channel);
        if (!ch) throw new HttpError(404, "not_found", `Canal "${a.channel}" não encontrado.`);
        channelId = (await requireVisibleChannel(db, wsId, ch.id, userId)).id;
        await assertRoutineChannel(db, ch, agent);
      } else {
        channelId = (await findOrCreateDm(db, wsId, { type: "user", id: userId }, { type: "agent", id: agent.id }, userId)).channel.id;
      }
      const row = await insertRoutine(db, wsId, {
        agentId: agent.id,
        name: a.name,
        prompt: a.prompt,
        cron: a.cron,
        timezone,
        channelId,
        enabled: true,
        kind: "custom",
        createdBy: userId,
      });
      await c.get("hub").rt.pump();
      return toRoutineDTO(row);
    },
  },
  {
    name: "criar_tarefa",
    description: "Cria uma tarefa no quadro do time. Atribuir a um agente faz ele começar a trabalhar nela.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Título."),
        description: str("Descrição."),
        status: { type: "string", enum: [...TASK_STATUSES] },
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        labels: { type: "array", items: { type: "string" } },
        project: str("Projeto."),
        assigneeAgent: str("Handle do agente responsável."),
        assigneeUserEmail: str("E-mail da pessoa responsável."),
      },
      required: ["title"],
    },
    schema: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(20_000).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      labels: z.array(z.string().max(40)).max(10).optional(),
      project: z.string().max(60).optional(),
      assigneeAgent: z.string().optional(),
      assigneeUserEmail: z.string().optional(),
    }),
    run: async (c, a) => {
      const db = c.env.DB;
      const wsId = c.get("wsId");
      let assignee: ActorRef | null = null;
      if (a.assigneeAgent) assignee = { type: "agent", id: (await requireAgentByHandle(db, wsId, a.assigneeAgent)).id };
      else if (a.assigneeUserEmail) {
        const u = await first<{ id: string }>(
          db,
          "SELECT u.id FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ? AND lower(u.email) = lower(?)",
          wsId,
          a.assigneeUserEmail,
        );
        if (!u) throw new HttpError(404, "not_found", "Pessoa não encontrada neste workspace.");
        assignee = { type: "user", id: u.id };
      }
      return createTask(c.get("hub"), userActor(c.get("userId"), isAdmin(c)), {
        title: a.title,
        description: a.description,
        status: a.status,
        priority: a.priority,
        labels: a.labels,
        project: a.project ?? null,
        assignee,
      });
    },
  },
  {
    name: "listar_tarefas",
    description: "Lista tarefas do quadro, com filtro opcional de status (todo, doing, review, done) e texto.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: [...TASK_STATUSES] }, q: str("Texto no título ou descrição.") } },
    schema: z.object({ status: z.enum(TASK_STATUSES).optional(), q: z.string().max(200).optional() }),
    run: async (c, a) => ({ items: await listTasks(c.env.DB, c.get("wsId"), { statuses: a.status ? [a.status] : undefined, q: a.q, limit: 200 }) }),
  },
  {
    name: "buscar",
    description: "Busca em mensagens (dos canais que você vê), tarefas, wiki e arquivos.",
    inputSchema: { type: "object", properties: { q: str("Termos de busca.") }, required: ["q"] },
    schema: z.object({ q: z.string().min(1).max(200) }),
    run: async (c, a) => searchWorkspace(c.env.DB, c.get("wsId"), userActor(c.get("userId"), isAdmin(c)), a.q),
  },
];

interface RpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

type RpcResponse = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const rpcError = (id: RpcRequest["id"], code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleOne(c: Context<WsEnv>, req: RpcRequest): Promise<RpcResponse | null> {
  const isNotification = req.id === undefined;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return isNotification ? null : rpcError(req.id, -32600, "Requisição JSON-RPC inválida.");
  const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;
  if (isNotification) return null; // notifications/initialized, cancelled etc.: nada a responder
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Ferramentas do workspace Puxibot: listar e criar agentes, pedir trabalho a um agente, criar rotinas e tarefas, listar tarefas e buscar. As ações usam as permissões da pessoa dona do token.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Ferramenta desconhecida: ${String(params.name)}`);
      try {
        const args = parseWith(tool.schema, params.arguments ?? {});
        const result = await tool.run(c, args);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } };
      } catch (err) {
        const message = err instanceof HttpError ? err.message : "Erro interno ao executar a ferramenta.";
        if (!(err instanceof HttpError)) console.error(JSON.stringify({ msg: "mcp tool failed", tool: tool.name, error: String(err) }));
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } };
      }
    }
    default:
      return rpcError(id, -32601, `Método não suportado: ${req.method}`);
  }
}

mcpRoutes.post("/mcp", async (c) => {
  let payload: unknown;
  const text = await readTextLimited(c);
  try {
    payload = JSON.parse(text);
  } catch {
    return c.json(rpcError(null, -32700, "JSON inválido."), 400);
  }
  if (Array.isArray(payload)) {
    // Lote grande = muitas ferramentas em paralelo (cada `pedir_ao_agente` segura a requisição por minutos).
    if (payload.length === 0 || payload.length > MAX_BATCH) {
      return c.json(rpcError(null, -32600, `Lote JSON-RPC precisa ter de 1 a ${MAX_BATCH} itens.`), 400);
    }
    const out = (await Promise.all(payload.map((p) => handleOne(c, p as RpcRequest)))).filter((r): r is RpcResponse => r !== null);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const res = await handleOne(c, payload as RpcRequest);
  return res ? c.json(res) : c.body(null, 202);
});

// Sem sessão nem stream SSE iniciado pelo servidor (servidor sem estado).
mcpRoutes.get("/mcp", (c) => c.json(rpcError(null, -32000, "Este servidor MCP não abre stream SSE; use POST."), 405));
mcpRoutes.delete("/mcp", (c) => c.body(null, 405));

