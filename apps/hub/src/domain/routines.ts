import type { RoutineDTO } from "@puxibot/shared";
import { all, first, newId, run } from "../lib/db";
import { badRequest } from "../lib/errors";
import { cronProblem, nextCronRun } from "../lib/cron";
import { budgetState, getAgentRow } from "./agents";
import { findOrCreateDm } from "./channels";
import type { HubCtx } from "./context";
import { createJob } from "./jobs";
import { postDailySummary } from "./summary";
import { toRoutineDTO, type AgentRow, type ChannelRow, type JobRow, type RoutineRow } from "./rows";
import { agentCanSeeChannel } from "./visibility";

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

export async function getRoutine(db: D1Database, wsId: string, id: string): Promise<RoutineRow | null> {
  return first<RoutineRow>(db, "SELECT * FROM routines WHERE workspace_id = ? AND id = ?", wsId, id);
}

/** Valida cron + fuso (400 com mensagem em português). */
export function assertValidSchedule(cron: string, timezone: string): void {
  const problem = cronProblem(cron, timezone);
  if (problem) throw badRequest(problem, "invalid_cron");
}

/**
 * Canal de rotina: o agente precisa enxergá-lo (nunca só de humanos; privado/DM só se ele for membro).
 * Sem isso a rotina levaria o contexto do canal ao agente e publicaria lá a resposta dele.
 */
export async function assertRoutineChannel(db: D1Database, ch: ChannelRow, agent: Pick<AgentRow, "id" | "name">): Promise<void> {
  if (ch.humans_only === 1) throw badRequest("Rotinas de agente não podem publicar num canal só de humanos.", "invalid_channel");
  if (!(await agentCanSeeChannel(db, ch, agent.id))) {
    throw badRequest(`${agent.name} não é membro deste canal; adicione o agente ao canal antes de criar a rotina.`, "invalid_channel");
  }
}

/** Próximo disparo depois de `after`; `null` se a rotina está desligada ou a expressão é inválida. */
export function computeNextRun(r: Pick<RoutineRow, "cron" | "timezone" | "enabled">, after = Date.now()): number | null {
  if (!r.enabled) return null;
  try {
    return nextCronRun(r.cron, r.timezone || DEFAULT_TIMEZONE, after);
  } catch {
    return null;
  }
}

export interface NewRoutine {
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  channelId: string | null;
  enabled: boolean;
  kind: RoutineDTO["kind"];
  createdBy: string;
}

export async function insertRoutine(db: D1Database, wsId: string, input: NewRoutine): Promise<RoutineRow> {
  const now = Date.now();
  const row: RoutineRow = {
    id: newId(),
    workspace_id: wsId,
    agent_id: input.agentId,
    name: input.name,
    prompt: input.prompt,
    cron: input.cron.trim().replace(/\s+/g, " "),
    timezone: input.timezone,
    channel_id: input.channelId,
    enabled: input.enabled ? 1 : 0,
    kind: input.kind,
    next_run_at: null,
    last_run_at: null,
    created_by: input.createdBy,
    created_at: now,
  };
  row.next_run_at = computeNextRun(row, now);
  await run(
    db,
    `INSERT INTO routines (id, workspace_id, agent_id, name, prompt, cron, timezone, channel_id, enabled, kind,
       next_run_at, last_run_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    row.id,
    row.workspace_id,
    row.agent_id,
    row.name,
    row.prompt,
    row.cron,
    row.timezone,
    row.channel_id,
    row.enabled,
    row.kind,
    row.next_run_at,
    row.created_by,
    row.created_at,
  );
  return row;
}

/** Rotinas ligadas sem `next_run_at` (ex.: criadas antes da segunda leva) ganham o próximo horário. */
export async function backfillRoutineSchedules(db: D1Database, wsId: string | null): Promise<number> {
  const rows = wsId
    ? await all<RoutineRow>(db, "SELECT * FROM routines WHERE workspace_id = ? AND enabled = 1 AND next_run_at IS NULL LIMIT 200", wsId)
    : await all<RoutineRow>(db, "SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NULL LIMIT 500");
  let fixed = 0;
  for (const r of rows) {
    const next = computeNextRun(r);
    if (next == null) continue;
    fixed += await run(
      db,
      "UPDATE routines SET next_run_at = ? WHERE workspace_id = ? AND id = ? AND next_run_at IS NULL",
      next,
      r.workspace_id,
      r.id,
    );
  }
  return fixed;
}

export async function nextRoutineRunAt(db: D1Database, wsId: string): Promise<number | null> {
  const row = await first<{ t: number | null }>(
    db,
    "SELECT MIN(next_run_at) AS t FROM routines WHERE workspace_id = ? AND enabled = 1 AND next_run_at IS NOT NULL",
    wsId,
  );
  return row?.t ?? null;
}

export interface RoutineRunResult {
  kind: RoutineDTO["kind"];
  job: JobRow | null;
  messageId: string | null;
  skipped: string | null;
}

/**
 * Executa a rotina uma vez. `custom`: cria job (`origin = 'routine'`, sujeito à política de autoinício; com
 * `manualUserId`, vira pedido daquela pessoa). `daily_summary`: o próprio hub monta o resumo, sem job nem IA.
 */
export async function executeRoutine(ctx: HubCtx, routine: RoutineRow, manualUserId: string | null = null): Promise<RoutineRunResult> {
  const db = ctx.env.DB;
  const agent = await getAgentRow(db, ctx.wsId, routine.agent_id);
  if (!agent) return { kind: routine.kind, job: null, messageId: null, skipped: "agent_missing" };
  if (routine.kind === "daily_summary") {
    const msg = await postDailySummary(ctx, agent, routine);
    return { kind: routine.kind, job: null, messageId: msg?.id ?? null, skipped: msg ? null : "no_channel" };
  }
  if (agent.status === "paused") return { kind: routine.kind, job: null, messageId: null, skipped: "agent_paused" };
  if ((await budgetState(db, agent)).exhausted) return { kind: routine.kind, job: null, messageId: null, skipped: "budget" };
  const prepare = routine.kind === "prepare";
  const job = await createJob(ctx, {
    agent,
    // "Executar agora" de uma preparação continua sendo preparação: ninguém pediu uma ação.
    origin: manualUserId && !prepare ? "user" : "routine",
    prompt: prepare ? routine.prompt : `Rotina "${routine.name}":\n\n${routine.prompt}`,
    channelId: routine.channel_id,
    requestedByUserId: prepare ? null : manualUserId,
    routineId: routine.id,
    mode: prepare ? "prepare" : null,
  });
  return { kind: routine.kind, job, messageId: null, skipped: null };
}

/**
 * Chamado pelo alarme do WorkspaceHub: dispara as rotinas vencidas. Cada uma é "reivindicada" com um UPDATE
 * condicional em `next_run_at` (avança para o próximo horário antes de executar), então não roda duas vezes.
 */
export async function fireDueRoutines(ctx: HubCtx, now = Date.now()): Promise<RoutineRunResult[]> {
  const db = ctx.env.DB;
  const due = await all<RoutineRow>(
    db,
    "SELECT * FROM routines WHERE workspace_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 50",
    ctx.wsId,
    now,
  );
  const results: RoutineRunResult[] = [];
  for (const r of due) {
    const next = computeNextRun(r, Math.max(now, r.next_run_at ?? now));
    const claimed = await run(
      db,
      "UPDATE routines SET next_run_at = ?, last_run_at = ? WHERE workspace_id = ? AND id = ? AND next_run_at = ?",
      next,
      now,
      ctx.wsId,
      r.id,
      r.next_run_at,
    );
    if (claimed === 0) continue;
    try {
      results.push(await executeRoutine(ctx, { ...r, next_run_at: next, last_run_at: now }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "routine failed", routineId: r.id, error: String(err), stack: (err as Error)?.stack }));
    }
  }
  return results;
}

export { toRoutineDTO };

/** Usado pelo cron do Worker: backfill global e `pump` nos WorkspaceHubs com rotina vencendo na próxima hora. */
export async function wakeRoutineHubs(env: import("../env").AppEnv): Promise<number> {
  await backfillRoutineSchedules(env.DB, null);
  const rows = await all<{ workspace_id: string }>(
    env.DB,
    "SELECT DISTINCT workspace_id FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 1000",
    Date.now() + 60 * 60_000,
  );
  for (const r of rows) {
    try {
      await env.WORKSPACE_HUB.getByName(r.workspace_id).pump(r.workspace_id);
    } catch (err) {
      console.error(JSON.stringify({ msg: "wake hub failed", workspaceId: r.workspace_id, error: String(err) }));
    }
  }
  return rows.length;
}

// ---------- Preparação automática ----------
export const PREPARE_DEFAULT_CRON = "0 8-18/2 * * 1-5";
export const PREPARE_ROUTINE_NAME = "Preparação automática";

export function preparePrompt(ownerName: string): string {
  return (
    `Preparação automática para ${ownerName}. Olhe as fontes a que você tem acesso (conectores, tarefas e conversas) e veja se há algo concreto e em aberto que valha adiantar: ` +
    "um pedido sem resposta, um compromisso com prazo, um problema, um risco. Se houver, prepare um rascunho e avise em poucas frases, com uma pergunta que ofereça o próximo passo. " +
    "Se não houver nada assim, termine com a resposta vazia."
  );
}

/**
 * Liga, ajusta ou desliga a preparação automática de um agente: uma rotina `prepare` que publica na DM entre
 * o agente e o responsável. Os trabalhos dela nunca alteram um conector (ver `checkAction` e a API de ferramentas).
 */
export async function setProactive(
  ctx: HubCtx,
  agent: AgentRow,
  input: { enabled: boolean; cron?: string; timezone?: string },
): Promise<RoutineRow | null> {
  const db = ctx.env.DB;
  const existing = await first<RoutineRow>(db, "SELECT * FROM routines WHERE workspace_id = ? AND agent_id = ? AND kind = 'prepare'", ctx.wsId, agent.id);
  if (!input.enabled) {
    if (existing) await run(db, "DELETE FROM routines WHERE workspace_id = ? AND id = ?", ctx.wsId, existing.id);
    return null;
  }
  const cron = (input.cron ?? existing?.cron ?? PREPARE_DEFAULT_CRON).trim().replace(/\s+/g, " ");
  const timezone = input.timezone ?? existing?.timezone ?? DEFAULT_TIMEZONE;
  assertValidSchedule(cron, timezone);
  const owner = await first<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", agent.owner_user_id);
  const { channel } = await findOrCreateDm(db, ctx.wsId, { type: "user", id: agent.owner_user_id }, { type: "agent", id: agent.id }, agent.owner_user_id);
  let row: RoutineRow;
  if (existing) {
    row = { ...existing, cron, timezone, enabled: 1, channel_id: channel.id };
    row.next_run_at = computeNextRun(row);
    await run(db, "UPDATE routines SET cron = ?, timezone = ?, enabled = 1, channel_id = ?, next_run_at = ? WHERE workspace_id = ? AND id = ?", cron, timezone, channel.id, row.next_run_at, ctx.wsId, existing.id);
  } else {
    row = await insertRoutine(db, ctx.wsId, {
      agentId: agent.id,
      name: PREPARE_ROUTINE_NAME,
      prompt: preparePrompt(owner?.name ?? "a pessoa responsável"),
      cron,
      timezone,
      channelId: channel.id,
      enabled: true,
      kind: "prepare",
      createdBy: agent.owner_user_id,
    });
  }
  await ctx.rt.pump();
  return row;
}
