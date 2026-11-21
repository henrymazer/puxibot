import { all, first } from "../lib/db";
import { conflict, forbidden, HttpError, notFound } from "../lib/errors";
import { budgetState, canTalkTo, getAgentRow, parseCallable } from "./agents";
import type { HubCtx } from "./context";
import { cancelJob, createJob, getJobRow } from "./jobs";
import type { AgentRow, JobRow } from "./rows";

/** Profundidade máxima de consultas encadeadas (A consulta B que consulta C...). */
export const MAX_CONSULT_DEPTH = 3;
export const DEFAULT_WAIT_MS = 25 * 60_000;
/**
 * Consulta que nenhum runner pegou neste tempo é desistida (job filho cancelado). Caso típico: runner com
 * capacidade 1 ocupado pelo próprio agente que consulta — a resposta nunca viria.
 */
export const CONSULT_QUEUE_TIMEOUT_MS = 90_000;

/** Agentes da cadeia de jobs pais (do job atual até a raiz), com a profundidade. */
export async function jobChain(db: D1Database, wsId: string, job: JobRow): Promise<{ agentIds: Set<string>; depth: number }> {
  const agentIds = new Set<string>([job.agent_id]);
  let depth = 0;
  let parentId = job.parent_job_id;
  while (parentId && depth < 20) {
    const parent = await first<{ agent_id: string; parent_job_id: string | null }>(
      db,
      "SELECT agent_id, parent_job_id FROM jobs WHERE workspace_id = ? AND id = ?",
      wsId,
      parentId,
    );
    if (!parent) break;
    agentIds.add(parent.agent_id);
    depth += 1;
    parentId = parent.parent_job_id;
  }
  return { agentIds, depth };
}

/**
 * Regras de `consultar_agente`: o alvo aceita consultas (`agentsCanConsult`), o chamador pode chamá-lo
 * (`callableAgentsMode`/`callableAgentIds`), sem ciclos (alvo já na cadeia) e até MAX_CONSULT_DEPTH níveis.
 */
export async function assertCanConsult(
  db: D1Database,
  wsId: string,
  caller: AgentRow,
  target: AgentRow,
  job: JobRow,
  principalUserId: string,
): Promise<void> {
  if (target.id === caller.id) throw conflict("Um agente não pode consultar a si mesmo.", "consult_self");
  if (target.is_assistant === 1 && target.owner_user_id !== caller.owner_user_id) {
    throw forbidden(`${target.name} é assistente pessoal de outra pessoa e não aceita consultas.`, "consult_denied");
  }
  // "Quem pode falar" vale também por tabela: a pessoa por quem o chamador age precisa poder falar com o alvo.
  if (!(await canTalkTo(db, target, principalUserId))) {
    throw forbidden(
      `Quem pediu este trabalho não tem permissão para falar com ${target.name} (@${target.handle}), então você também não pode consultá-lo.`,
      "consult_denied",
    );
  }
  if (target.agents_can_consult !== 1) {
    throw forbidden(`${target.name} (@${target.handle}) não aceita consultas de outros agentes.`, "consult_denied");
  }
  if (caller.callable_agents_mode === "none") {
    throw forbidden(`${caller.name} não tem permissão para consultar outros agentes.`, "consult_denied");
  }
  if (caller.callable_agents_mode === "only" && !parseCallable(caller).includes(target.id)) {
    throw forbidden(`${caller.name} não pode consultar @${target.handle}: ele não está na lista de agentes que pode chamar.`, "consult_denied");
  }
  if (target.status === "paused") throw conflict(`${target.name} (@${target.handle}) está pausado.`, "agent_paused");
  if ((await budgetState(db, target)).exhausted) throw conflict(`${target.name} atingiu o orçamento do mês.`, "budget_exhausted");
  const chain = await jobChain(db, wsId, job);
  if (chain.agentIds.has(target.id)) {
    throw conflict(`@${target.handle} já está nesta cadeia de consultas; consultá-lo de novo criaria um ciclo.`, "consult_cycle");
  }
  if (chain.depth + 1 > MAX_CONSULT_DEPTH) {
    throw conflict(`Limite de ${MAX_CONSULT_DEPTH} consultas encadeadas atingido.`, "consult_depth");
  }
}

export interface WaitResult {
  status: JobRow["status"] | "timeout" | "no_runner";
  text: string;
  error: string | null;
  jobId: string;
}

/** Long-poll no D1 até o job terminar (ou o tempo acabar, ou `abort()` devolver true). */
export async function waitForJob(
  db: D1Database,
  wsId: string,
  jobId: string,
  opts: { timeoutMs: number; intervalMs?: number; abort?: () => Promise<boolean>; queueTimeoutMs?: number },
): Promise<WaitResult> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const interval = opts.intervalMs ?? 750;
  for (;;) {
    const job = await getJobRow(db, wsId, jobId);
    if (!job) throw notFound("O job da consulta sumiu (o agente foi apagado?).");
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      return { status: job.status, text: job.result_text ?? "", error: job.error, jobId };
    }
    if (Date.now() >= deadline) return { status: "timeout", text: "", error: null, jobId };
    if (opts.queueTimeoutMs != null && job.status === "queued" && Date.now() - started >= opts.queueTimeoutMs) {
      return { status: "no_runner", text: "", error: null, jobId };
    }
    if (opts.abort && (await opts.abort())) return { status: "cancelled", text: "", error: "A consulta foi interrompida.", jobId };
    await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - Date.now()))));
  }
}

/** Cria o job filho de consulta e espera a resposta. */
export async function consultAgent(
  ctx: HubCtx,
  input: { caller: AgentRow; target: AgentRow; job: JobRow; principalUserId: string; prompt: string; timeoutMs: number; queueTimeoutMs?: number },
): Promise<WaitResult & { agent: { handle: string; name: string } }> {
  const db = ctx.env.DB;
  await assertCanConsult(db, ctx.wsId, input.caller, input.target, input.job, input.principalUserId);
  const child = await createJob(ctx, {
    agent: input.target,
    origin: "agent",
    prompt:
      `${input.caller.name} (@${input.caller.handle}) está consultando você:\n\n${input.prompt}\n\n` +
      `Responda de forma completa e autoexplicativa: sua resposta volta direto para ${input.caller.name}.`,
    requestedByUserId: input.job.requested_by_user_id,
    parentJobId: input.job.id,
  });
  const result = await waitForJob(db, ctx.wsId, child.id, {
    timeoutMs: input.timeoutMs,
    queueTimeoutMs: input.queueTimeoutMs ?? CONSULT_QUEUE_TIMEOUT_MS,
    abort: async () => {
      const parent = await getJobRow(db, ctx.wsId, input.job.id);
      return !parent || (parent.status !== "assigned" && parent.status !== "running");
    },
  });
  if (result.status === "no_runner" || (result.status === "cancelled" && result.error === "A consulta foi interrompida.")) {
    const fresh = await getJobRow(db, ctx.wsId, child.id);
    if (fresh) await cancelJob(ctx, fresh);
  }
  return { ...result, agent: { handle: input.target.handle, name: input.target.name } };
}

export async function requireAgentByHandle(db: D1Database, wsId: string, handle: string): Promise<AgentRow> {
  const clean = handle.trim().replace(/^@/, "").toLowerCase();
  const rows = await all<AgentRow>(db, "SELECT * FROM agents WHERE workspace_id = ? AND handle = ?", wsId, clean);
  if (!rows[0]) throw new HttpError(404, "not_found", `Nenhum agente com o handle @${clean}.`);
  return rows[0];
}

export { getAgentRow };
