import { Hono, type Context } from "hono";
import { z } from "zod";
import { createRoutineSchema } from "@puxibot/shared";
import { all, run, type SqlValue } from "../lib/db";
import { forbidden, notFound } from "../lib/errors";
import { readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { requireAgentRow } from "../domain/agents";
import { requireVisibleChannel } from "../domain/channels";
import { assertRoutineChannel, assertValidSchedule, computeNextRun, executeRoutine, getRoutine, insertRoutine } from "../domain/routines";
import { toJobDTO, toRoutineDTO, type AgentRow, type RoutineRow } from "../domain/rows";

/** /api/workspaces/:ws/routines — escrita: responsável do agente ou admin. */
export const routineRoutes = new Hono<WsEnv>();

function canManage(c: Context<WsEnv>, agent: AgentRow) {
  // Assistente pessoal age como a dona dele (e roda no runner dela): só ela programa rotinas dele.
  if (agent.is_assistant === 1) return agent.owner_user_id === c.get("userId");
  return agent.owner_user_id === c.get("userId") || isAdmin(c);
}

/** Apagar: também admin (limpeza), inclusive rotina de assistente. */
function canDelete(c: Context<WsEnv>, agent: AgentRow) {
  return agent.owner_user_id === c.get("userId") || isAdmin(c);
}

async function requireManagedRoutine(c: Context<WsEnv>): Promise<{ routine: RoutineRow; agent: AgentRow }> {
  const routine = await getRoutine(c.env.DB, c.get("wsId"), c.req.param("id")!);
  if (!routine) throw notFound("Rotina não encontrada.");
  const agent = await requireAgentRow(c.env.DB, c.get("wsId"), routine.agent_id);
  if (agent.is_assistant === 1 && agent.owner_user_id !== c.get("userId") && !isAdmin(c)) throw notFound("Rotina não encontrada.");
  return { routine, agent };
}

routineRoutes.get("/routines", async (c) => {
  const agentId = c.req.query("agentId");
  let sql = `SELECT r.* FROM routines r JOIN agents a ON a.id = r.agent_id WHERE r.workspace_id = ?`;
  const params: SqlValue[] = [c.get("wsId")];
  // Rotinas do assistente pessoal de outra pessoa não aparecem (exceto para admins).
  if (!isAdmin(c)) {
    sql += " AND (a.is_assistant = 0 OR a.owner_user_id = ?)";
    params.push(c.get("userId"));
  }
  if (agentId) {
    sql += " AND r.agent_id = ?";
    params.push(agentId);
  }
  sql += " ORDER BY r.created_at";
  const rows = await all<RoutineRow>(c.env.DB, sql, ...params);
  return c.json({ items: rows.map(toRoutineDTO) });
});

routineRoutes.post("/routines", async (c) => {
  const body = await readBody(c, createRoutineSchema);
  const agent = await requireAgentRow(c.env.DB, c.get("wsId"), body.agentId);
  if (!canManage(c, agent)) throw forbidden("Só o responsável pelo agente ou um admin cria rotinas para ele.");
  assertValidSchedule(body.cron, body.timezone);
  if (body.channelId) {
    const ch = await requireVisibleChannel(c.env.DB, c.get("wsId"), body.channelId, c.get("userId"));
    await assertRoutineChannel(c.env.DB, ch, agent);
  }
  const row = await insertRoutine(c.env.DB, c.get("wsId"), {
    agentId: agent.id,
    name: body.name,
    prompt: body.prompt,
    cron: body.cron,
    timezone: body.timezone,
    channelId: body.channelId ?? null,
    enabled: body.enabled,
    kind: "custom",
    createdBy: c.get("userId"),
  });
  await c.get("hub").rt.pump(); // reagenda o alarme do WorkspaceHub
  return c.json(toRoutineDTO(row), 201);
});

routineRoutes.get("/routines/:id", async (c) => {
  const { routine } = await requireManagedRoutine(c);
  return c.json(toRoutineDTO(routine));
});

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  prompt: z.string().max(20_000).optional(),
  cron: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  channelId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

routineRoutes.patch("/routines/:id", async (c) => {
  const { routine, agent } = await requireManagedRoutine(c);
  if (!canManage(c, agent)) throw forbidden("Só o responsável pelo agente ou um admin muda a rotina.");
  const body = await readBody(c, patchSchema);
  const next: RoutineRow = {
    ...routine,
    name: body.name ?? routine.name,
    prompt: body.prompt ?? routine.prompt,
    cron: body.cron !== undefined ? body.cron.trim().replace(/\s+/g, " ") : routine.cron,
    timezone: body.timezone ?? routine.timezone,
    channel_id: body.channelId !== undefined ? body.channelId : routine.channel_id,
    enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : routine.enabled,
  };
  assertValidSchedule(next.cron, next.timezone);
  if (body.channelId) {
    const ch = await requireVisibleChannel(c.env.DB, c.get("wsId"), body.channelId, c.get("userId"));
    await assertRoutineChannel(c.env.DB, ch, agent);
  }
  const scheduleChanged = next.cron !== routine.cron || next.timezone !== routine.timezone || next.enabled !== routine.enabled;
  if (scheduleChanged || routine.next_run_at == null) next.next_run_at = computeNextRun(next);
  await run(
    c.env.DB,
    `UPDATE routines SET name = ?, prompt = ?, cron = ?, timezone = ?, channel_id = ?, enabled = ?, next_run_at = ?
     WHERE workspace_id = ? AND id = ?`,
    next.name,
    next.prompt,
    next.cron,
    next.timezone,
    next.channel_id,
    next.enabled,
    next.next_run_at,
    c.get("wsId"),
    routine.id,
  );
  await c.get("hub").rt.pump();
  return c.json(toRoutineDTO(next));
});

routineRoutes.delete("/routines/:id", async (c) => {
  const { routine, agent } = await requireManagedRoutine(c);
  if (!canDelete(c, agent)) throw forbidden("Só o responsável pelo agente ou um admin apaga a rotina.");
  await run(c.env.DB, "DELETE FROM routines WHERE workspace_id = ? AND id = ?", c.get("wsId"), routine.id);
  await c.get("hub").rt.pump();
  return c.body(null, 204);
});

/** Executa agora (não muda o próximo horário agendado). Pedido de pessoa: não passa pela aprovação de autoinício. */
routineRoutes.post("/routines/:id/run", async (c) => {
  const { routine, agent } = await requireManagedRoutine(c);
  if (!canManage(c, agent)) throw forbidden("Só o responsável pelo agente ou um admin executa a rotina.");
  const result = await executeRoutine(c.get("hub"), routine, c.get("userId"));
  await run(c.env.DB, "UPDATE routines SET last_run_at = ? WHERE workspace_id = ? AND id = ?", Date.now(), c.get("wsId"), routine.id);
  return c.json({
    kind: result.kind,
    job: result.job ? toJobDTO(result.job) : null,
    messageId: result.messageId,
    skipped: result.skipped,
  });
});
