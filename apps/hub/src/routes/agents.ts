import { Hono, type Context } from "hono";
import { z } from "zod";
import { BROWSER_TOOL, CLIS, createAgentSchema, currentPeriod, handleSchema, NATIVE_TOOLS, type JobDTO, type JobEventDTO } from "@puxibot/shared";
import { all, first, placeholders, stmt } from "../lib/db";
import { badRequest, forbidden, HttpError, notFound } from "../lib/errors";
import { readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { agentUsage, createAgent, getAgentDTO, handleTaken, listAgents, publishAgent, requireAgentRow } from "../domain/agents";
import { getMember } from "../domain/members";
import { toJobDTO, toJobEventDTO, type AgentRow, type JobEventRow, type JobRow } from "../domain/rows";

/** /api/workspaces/:ws/agents */
export const agentRoutes = new Hono<WsEnv>();

function canManageAgent(c: Context<WsEnv>, agent: AgentRow): boolean {
  return agent.owner_user_id === c.get("userId") || isAdmin(c);
}

async function assertMember(c: Context<WsEnv>, userId: string) {
  if (!(await getMember(c.env.DB, c.get("wsId"), userId))) throw notFound("Pessoa não encontrada neste workspace.");
}

async function assertSector(c: Context<WsEnv>, sectorId: string | null | undefined) {
  if (!sectorId) return;
  const row = await first(c.env.DB, "SELECT 1 AS one FROM sectors WHERE workspace_id = ? AND id = ?", c.get("wsId"), sectorId);
  if (!row) throw notFound("Setor não encontrado.");
}

agentRoutes.get("/agents", async (c) => c.json({ items: await listAgents(c.env.DB, c.get("wsId")) }));

agentRoutes.post("/agents", async (c) => {
  const body = await readBody(c, createAgentSchema);
  const ownerUserId = body.ownerUserId ?? c.get("userId");
  if (ownerUserId !== c.get("userId")) {
    if (!isAdmin(c)) throw forbidden("Só admins escolhem outro responsável.");
    await assertMember(c, ownerUserId);
  }
  await assertSector(c, body.sectorId);
  const agent = await createAgent(c.get("hub"), {
    handle: body.handle,
    name: body.name,
    role: body.role ?? null,
    description: body.description ?? null,
    instructions: body.instructions,
    sectorId: body.sectorId ?? null,
    ownerUserId,
    avatarColor: body.avatarColor ?? null,
    avatarAccessory: body.avatarAccessory ?? null,
  });
  return c.json(agent, 201);
});

agentRoutes.get("/agents/:id", async (c) => c.json(await getAgentDTO(c.env.DB, c.get("wsId"), c.req.param("id"))));

const toolLevel = z.enum(["none", "read", "write"]);
const patchAgentSchema = z.object({
  handle: handleSchema.optional(),
  name: z.string().min(1).max(60).optional(),
  role: z.string().max(60).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  instructions: z.string().max(50_000).optional(),
  avatarColor: z.string().max(20).nullable().optional(),
  avatarAccessory: z.string().max(20).nullable().optional(),
  sectorId: z.string().nullable().optional(),
  accessMode: z.enum(["workspace", "restricted", "owner"]).optional(),
  allowedUserIds: z.array(z.string()).max(500).optional(),
  agentsCanConsult: z.boolean().optional(),
  callableAgentsMode: z.enum(["all", "only", "none"]).optional(),
  callableAgentIds: z.array(z.string()).max(500).optional(),
  preferredCli: z.enum(CLIS).nullable().optional(),
  preferredModel: z.string().max(100).nullable().optional(),
  selfStartPolicy: z.enum(["ask", "run"]).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(50).optional(),
  maxPrsPerHour: z.number().int().min(0).max(100).optional(),
  status: z.enum(["active", "paused"]).optional(),
  toolPerms: z.record(z.string(), toolLevel).optional(),
  skillIds: z.array(z.string()).max(200).optional(),
  // Só admin:
  ownerUserId: z.string().optional(),
  budgetTokensMonth: z.number().int().min(0).nullable().optional(),
  budgetRunsMonth: z.number().int().min(0).nullable().optional(),
  trustMode: z.enum(["ask", "auto"]).optional(),
  learnSkills: z.boolean().optional(),
});

/** Colunas simples: campo do PATCH → coluna. Booleanos convertidos para 0/1. */
const SIMPLE_COLUMNS = {
  handle: "handle",
  name: "name",
  role: "role",
  description: "description",
  instructions: "instructions",
  avatarColor: "avatar_color",
  avatarAccessory: "avatar_accessory",
  sectorId: "sector_id",
  accessMode: "access_mode",
  agentsCanConsult: "agents_can_consult",
  callableAgentsMode: "callable_agents_mode",
  preferredCli: "preferred_cli",
  preferredModel: "preferred_model",
  selfStartPolicy: "self_start_policy",
  maxConcurrentJobs: "max_concurrent_jobs",
  maxPrsPerHour: "max_prs_per_hour",
  status: "status",
  ownerUserId: "owner_user_id",
  budgetTokensMonth: "budget_tokens_month",
  budgetRunsMonth: "budget_runs_month",
  trustMode: "trust_mode",
  learnSkills: "learn_skills",
} as const;

agentRoutes.patch("/agents/:id", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const agent = await requireAgentRow(db, wsId, c.req.param("id"));
  if (!canManageAgent(c, agent)) throw forbidden("Só o responsável pelo agente ou um admin pode mudá-lo.");
  const body = await readBody(c, patchAgentSchema);
  // Assistente pessoal age como a dona dele, no runner dela: admin só pausa/reativa e mexe no orçamento.
  if (agent.is_assistant === 1 && agent.owner_user_id !== userId) {
    const allowed = new Set(["status", "budgetTokensMonth", "budgetRunsMonth"]);
    const other = Object.entries(body).filter(([k, v]) => v !== undefined && !allowed.has(k));
    if (other.length) throw forbidden("O assistente pessoal só é configurado pela pessoa dona dele (admins podem pausar e definir orçamento).", "assistant_owner_only");
  }

  if ((body.ownerUserId !== undefined || body.budgetTokensMonth !== undefined || body.budgetRunsMonth !== undefined) && !isAdmin(c)) {
    throw forbidden("Só admins mudam o responsável e o orçamento.", "admin_required");
  }
  if (body.ownerUserId !== undefined) {
    if (agent.is_assistant === 1 && body.ownerUserId !== agent.owner_user_id) {
      throw badRequest("O assistente pessoal não muda de dono.");
    }
    await assertMember(c, body.ownerUserId);
  }
  if (agent.is_assistant === 1 && body.accessMode !== undefined && body.accessMode !== "owner") {
    throw badRequest("O assistente pessoal só fala com o dono.");
  }
  if (body.handle !== undefined && body.handle !== agent.handle && (await handleTaken(db, wsId, body.handle))) {
    throw new HttpError(409, "handle_taken", `O handle @${body.handle} já está em uso.`);
  }
  await assertSector(c, body.sectorId);
  if (body.allowedUserIds) for (const id of body.allowedUserIds) await assertMember(c, id);
  if (body.callableAgentIds?.length) {
    const ids = [...new Set(body.callableAgentIds)];
    const found = await all<{ id: string }>(
      db,
      `SELECT id FROM agents WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})`,
      wsId,
      ...ids,
    );
    if (found.length !== ids.length) throw notFound("Agente da lista de chamadas não encontrado.");
  }
  if (body.skillIds?.length) {
    const ids = [...new Set(body.skillIds)];
    const found = await all<{ id: string }>(
      db,
      `SELECT id FROM skills WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})`,
      wsId,
      ...ids,
    );
    if (found.length !== ids.length) throw notFound("Skill não encontrada.");
  }

  const statements: D1PreparedStatement[] = [];
  const now = Date.now();
  for (const [field, column] of Object.entries(SIMPLE_COLUMNS) as [keyof typeof SIMPLE_COLUMNS, string][]) {
    const value = body[field];
    if (value === undefined) continue;
    const bound = typeof value === "boolean" ? (value ? 1 : 0) : value;
    // `column` vem de SIMPLE_COLUMNS (constante), nunca da entrada.
    statements.push(stmt(db, `UPDATE agents SET ${column} = ? WHERE workspace_id = ? AND id = ?`, bound, wsId, agent.id));
  }
  if (body.callableAgentIds !== undefined) {
    statements.push(
      stmt(db, "UPDATE agents SET callable_agents_json = ? WHERE workspace_id = ? AND id = ?", JSON.stringify([...new Set(body.callableAgentIds)]), wsId, agent.id),
    );
  }
  if (body.allowedUserIds !== undefined) {
    statements.push(stmt(db, "DELETE FROM agent_access WHERE agent_id = ?", agent.id));
    for (const id of new Set(body.allowedUserIds)) {
      statements.push(stmt(db, "INSERT INTO agent_access (agent_id, user_id) VALUES (?, ?)", agent.id, id));
    }
  }
  if (body.toolPerms !== undefined) {
    for (const [tool, level] of Object.entries(body.toolPerms)) {
      if (tool.startsWith("connector:")) {
        const connectorId = tool.slice("connector:".length);
        const connector = await first<{ owner_user_id: string }>(
          db,
          "SELECT owner_user_id FROM connectors WHERE workspace_id = ? AND id = ?",
          wsId,
          connectorId,
        );
        if (!connector) throw notFound("Conector não encontrado.");
        if (connector.owner_user_id !== userId) throw forbidden("Só quem conectou pode conceder acesso a este conector.", "connector_owner_required");
      } else if (tool === BROWSER_TOOL) {
        // O navegador roda no computador do responsável: só ele liga (admins podem desligar).
        if (level !== "none" && agent.owner_user_id !== userId) {
          throw forbidden("Só o responsável pelo agente liga o navegador: ele roda no computador dessa pessoa.", "owner_required");
        }
        if (level === "read") throw badRequest("O navegador não tem nível somente leitura: use ligado ou desligado.");
      } else if (!(NATIVE_TOOLS as readonly string[]).includes(tool)) {
        throw badRequest(`Ferramenta desconhecida: ${tool}`);
      }
      statements.push(
        stmt(
          db,
          `INSERT INTO agent_tool_perms (agent_id, tool, level) VALUES (?, ?, ?)
           ON CONFLICT (agent_id, tool) DO UPDATE SET level = excluded.level`,
          agent.id,
          tool,
          level,
        ),
      );
    }
  }
  if (body.skillIds !== undefined) {
    statements.push(stmt(db, "DELETE FROM agent_skills WHERE agent_id = ?", agent.id));
    for (const id of new Set(body.skillIds)) {
      statements.push(stmt(db, "INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)", agent.id, id));
    }
  }
  statements.push(stmt(db, "UPDATE agents SET updated_at = ? WHERE workspace_id = ? AND id = ?", now, wsId, agent.id));
  await db.batch(statements);
  const dto = await publishAgent(c.get("hub"), agent.id);
  if (agent.status === "paused" && dto.status === "active") await c.get("hub").rt.pump();
  return c.json(dto);
});

agentRoutes.delete("/agents/:id", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const agent = await requireAgentRow(db, wsId, c.req.param("id"));
  if (!canManageAgent(c, agent)) throw forbidden("Só o responsável pelo agente ou um admin pode apagá-lo.");
  if (agent.is_assistant === 1) throw badRequest("O assistente pessoal não pode ser apagado.", "assistant_protected");
  // Jobs ativos: avisa os runners antes de apagar (jobs saem em cascata).
  const active = await all<JobRow>(
    db,
    "SELECT * FROM jobs WHERE workspace_id = ? AND agent_id = ? AND status IN ('assigned','running')",
    wsId,
    agent.id,
  );
  for (const j of active) if (j.runner_id) await c.get("hub").rt.cancelOnRunner(j.id, j.runner_id);
  await db.batch([
    stmt(db, "DELETE FROM channel_members WHERE member_type = 'agent' AND member_id = ?", agent.id),
    stmt(db, "DELETE FROM agents WHERE workspace_id = ? AND id = ?", wsId, agent.id),
  ]);
  await c.get("hub").rt.publish({ type: "agent.deleted", agentId: agent.id }, null);
  return c.body(null, 204);
});

agentRoutes.get("/agents/:id/usage", async (c) => {
  const agent = await requireAgentRow(c.env.DB, c.get("wsId"), c.req.param("id"));
  if (!canManageAgent(c, agent)) throw forbidden("Só admins e o responsável veem o uso do agente.");
  const period = c.req.query("period") || currentPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest("Período inválido; use AAAA-MM.");
  return c.json(await agentUsage(c.env.DB, c.get("wsId"), agent.id, period));
});

agentRoutes.get("/agents/:id/activity", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const agent = await requireAgentRow(db, wsId, c.req.param("id"));
  const jobs = await all<JobRow>(
    db,
    "SELECT * FROM jobs WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 30",
    wsId,
    agent.id,
  );
  const visible = await filterVisibleJobs(c, jobs);
  const withContent = await jobsWithVisibleContent(c, visible);
  const readable = visible.filter((j) => withContent.has(j.id));
  const events = readable.length
    ? await all<JobEventRow>(
        db,
        `SELECT * FROM job_events WHERE job_id IN (${placeholders(readable.length)}) ORDER BY id`,
        ...readable.map((j) => j.id),
      )
    : [];
  return c.json({
    items: visible.map((j) => ({
      ...jobDTOFor(j, withContent),
      events: events.filter((e) => e.job_id === j.id).map(toJobEventDTO) as JobEventDTO[],
    })),
  });
});

/**
 * Jobs cujo conteúdo (pedido e eventos) a pessoa pode ler: os que ela pediu e os de conversas que ela enxerga.
 * Sem conversa (rotina, tarefa, consulta): quem pediu, o responsável pelo agente e admins.
 * O responsável e os admins continuam vendo que o job existe (status, custo), mas o pedido feito na DM ou no
 * canal privado de outra pessoa não vaza para eles.
 */
export async function jobsWithVisibleContent(c: Context<WsEnv>, jobs: JobRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (jobs.length === 0) return out;
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const channelIds = [...new Set(jobs.map((j) => j.channel_id).filter((x): x is string => !!x))];
  const visibleChannels = new Set<string>();
  if (channelIds.length) {
    const rows = await all<{ id: string }>(
      db,
      `SELECT c.id FROM channels c
       LEFT JOIN channel_members me ON me.channel_id = c.id AND me.member_type = 'user' AND me.member_id = ?
       WHERE c.workspace_id = ? AND c.id IN (${placeholders(channelIds.length)})
         AND ((c.kind = 'channel' AND c.is_private = 0) OR me.member_id IS NOT NULL)`,
      userId,
      wsId,
      ...channelIds,
    );
    for (const r of rows) visibleChannels.add(r.id);
  }
  const owned = new Set(
    (await all<{ id: string }>(db, "SELECT id FROM agents WHERE workspace_id = ? AND owner_user_id = ?", wsId, userId)).map((r) => r.id),
  );
  for (const j of jobs) {
    if (j.requested_by_user_id === userId) out.add(j.id);
    else if (j.channel_id) {
      if (visibleChannels.has(j.channel_id)) out.add(j.id);
    } else if (owned.has(j.agent_id) || isAdmin(c)) out.add(j.id);
  }
  return out;
}

/** `JobDTO` com o pedido apagado quando a pessoa não pode ler o conteúdo do job. */
export function jobDTOFor(job: JobRow, withContent: Set<string>): JobDTO {
  const dto = toJobDTO(job);
  return withContent.has(job.id) ? dto : { ...dto, prompt: "" };
}

/**
 * Jobs que a pessoa pode ver: admin vê todos; os demais veem os que pediram, os de agentes de que são
 * responsáveis e os de conversas que enxergam.
 */
export async function filterVisibleJobs(c: Context<WsEnv>, jobs: JobRow[]): Promise<JobRow[]> {
  if (isAdmin(c) || jobs.length === 0) return jobs;
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const channelIds = [...new Set(jobs.map((j) => j.channel_id).filter((x): x is string => !!x))];
  const visibleChannels = new Set<string>();
  if (channelIds.length) {
    const rows = await all<{ id: string }>(
      db,
      `SELECT c.id FROM channels c
       LEFT JOIN channel_members me ON me.channel_id = c.id AND me.member_type = 'user' AND me.member_id = ?
       WHERE c.workspace_id = ? AND c.id IN (${placeholders(channelIds.length)})
         AND ((c.kind = 'channel' AND c.is_private = 0) OR me.member_id IS NOT NULL)`,
      userId,
      wsId,
      ...channelIds,
    );
    for (const r of rows) visibleChannels.add(r.id);
  }
  const owned = new Set(
    (await all<{ id: string }>(db, "SELECT id FROM agents WHERE workspace_id = ? AND owner_user_id = ?", wsId, userId)).map((r) => r.id),
  );
  return jobs.filter(
    (j) =>
      j.requested_by_user_id === userId || owned.has(j.agent_id) || (j.channel_id != null && visibleChannels.has(j.channel_id)),
  );
}

