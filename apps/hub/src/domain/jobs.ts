import type { ApprovalDTO, JobDTO } from "@puxibot/shared";
import { first, newId, run, stmt } from "../lib/db";
import type { HubCtx } from "./context";
import { budgetState, canTalkTo, getAgentRow, maybeWarnBudget, publishAgent } from "./agents";
import { channelAudienceById } from "./channels";
import { adminUserIds } from "./members";
import { postSystemMessage } from "./messages";
import { links, notify } from "./notify";
import { toApprovalDTO, toJobDTO, type AgentRow, type ApprovalRow, type ChannelRow, type JobRow } from "./rows";

export async function getJobRow(db: D1Database, wsId: string, jobId: string): Promise<JobRow | null> {
  return first<JobRow>(db, "SELECT * FROM jobs WHERE workspace_id = ? AND id = ?", wsId, jobId);
}

/** Quem recebe eventos do job: membros do canal, ou responsável + quem pediu quando não há canal. */
export async function jobAudience(ctx: HubCtx, job: JobRow): Promise<string[] | null> {
  if (job.channel_id) return channelAudienceById(ctx.env.DB, ctx.wsId, job.channel_id);
  const agent = await getAgentRow(ctx.env.DB, ctx.wsId, job.agent_id);
  return [...new Set([agent?.owner_user_id, job.requested_by_user_id].filter((x): x is string => !!x))];
}

export async function publishJob(ctx: HubCtx, job: JobRow, opts: { agentChanged?: boolean } = {}): Promise<JobDTO> {
  const dto = toJobDTO(job);
  await ctx.rt.publish({ type: "job.updated", job: dto }, await jobAudience(ctx, job));
  // O estado `activity` do agente depende dos jobs; reenvia o agente quando o status muda.
  if (opts.agentChanged !== false) await publishAgent(ctx, job.agent_id);
  return dto;
}

export async function publishApproval(ctx: HubCtx, approval: ApprovalRow): Promise<ApprovalDTO> {
  const dto = toApprovalDTO(approval);
  const audience = new Set(await adminUserIds(ctx.env.DB, ctx.wsId));
  audience.add(approval.approver_user_id);
  await ctx.rt.publish({ type: "approval.upserted", approval: dto }, [...audience]);
  return dto;
}

export interface CreateJobInput {
  agent: AgentRow;
  origin: JobDTO["origin"];
  prompt: string;
  channelId?: string | null;
  threadRootId?: string | null;
  triggerMessageId?: string | null;
  requestedByUserId?: string | null;
  parentJobId?: string | null;
  routineId?: string | null;
  taskId?: string | null;
}

/** Trabalho que ninguém pediu: rotina, ou agente sem pedido humano na cadeia. */
export function isSelfStarted(input: Pick<CreateJobInput, "origin" | "requestedByUserId">): boolean {
  return input.origin === "routine" || (input.origin === "agent" && !input.requestedByUserId);
}

/**
 * Cria o job. Trabalho autoiniciado com `selfStartPolicy = 'ask'` nasce `awaiting_approval` com uma
 * aprovação `job_start` para o responsável; o resto nasce `queued` e a fila é reavaliada.
 * Não faz as checagens de "quem pode falar"/orçamento — use `requestAgentWork` para pedidos de pessoas.
 */
export async function createJob(ctx: HubCtx, input: CreateJobInput): Promise<JobRow> {
  const db = ctx.env.DB;
  const now = Date.now();
  const needsApproval = isSelfStarted(input) && input.agent.self_start_policy === "ask";
  const job: JobRow = {
    id: newId(),
    workspace_id: ctx.wsId,
    agent_id: input.agent.id,
    channel_id: input.channelId ?? null,
    thread_root_id: input.threadRootId ?? null,
    trigger_message_id: input.triggerMessageId ?? null,
    origin: input.origin,
    requested_by_user_id: input.requestedByUserId ?? null,
    parent_job_id: input.parentJobId ?? null,
    routine_id: input.routineId ?? null,
    prompt: input.prompt,
    status: needsApproval ? "awaiting_approval" : "queued",
    runner_id: null,
    runner_user_id: null,
    lease_expires_at: null,
    attempts: 0,
    cli: null,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    result_text: null,
    error: null,
    error_code: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    no_runner_notified_at: null,
    task_id: input.taskId ?? null,
    waiting_for_runner: 0,
  };
  const statements = [
    stmt(
      db,
      `INSERT INTO jobs (id, workspace_id, agent_id, channel_id, thread_root_id, trigger_message_id, origin,
         requested_by_user_id, parent_job_id, routine_id, prompt, status, attempts, input_tokens, output_tokens, created_at, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      job.id,
      job.workspace_id,
      job.agent_id,
      job.channel_id,
      job.thread_root_id,
      job.trigger_message_id,
      job.origin,
      job.requested_by_user_id,
      job.parent_job_id,
      job.routine_id,
      job.prompt,
      job.status,
      job.created_at,
      job.task_id,
    ),
  ];
  let approval: ApprovalRow | null = null;
  if (needsApproval) {
    approval = {
      id: newId(),
      workspace_id: ctx.wsId,
      agent_id: input.agent.id,
      job_id: job.id,
      kind: "job_start",
      title: `${input.agent.name} quer começar um trabalho`,
      details: input.prompt.slice(0, 2000),
      approver_user_id: input.agent.owner_user_id,
      status: "pending",
      decided_by: null,
      decided_at: null,
      decision_note: null,
      created_at: now,
    };
    statements.push(
      stmt(
        db,
        `INSERT INTO approvals (id, workspace_id, agent_id, job_id, kind, title, details, approver_user_id, status, created_at)
         VALUES (?, ?, ?, ?, 'job_start', ?, ?, ?, 'pending', ?)`,
        approval.id,
        approval.workspace_id,
        approval.agent_id,
        approval.job_id,
        approval.title,
        approval.details,
        approval.approver_user_id,
        approval.created_at,
      ),
    );
  }
  await db.batch(statements);
  await publishJob(ctx, job);
  if (approval) {
    await publishApproval(ctx, approval);
    await notify(ctx, {
      userId: approval.approver_user_id,
      kind: "approval",
      title: approval.title,
      body: approval.details,
      link: links.approvals(ctx.wsId),
    });
  } else {
    await ctx.rt.pump();
  }
  await maybeWarnBudget(ctx, input.agent.id);
  return job;
}

export interface AgentWorkRequest {
  agent: AgentRow;
  userId: string;
  channel: ChannelRow;
  prompt: string;
  triggerMessageId: string | null;
  threadRootId: string | null;
}

/**
 * Pedido de uma pessoa a um agente numa conversa. Checa, nesta ordem, pausa, "quem pode falar" e orçamento;
 * se bloquear, publica uma mensagem `system` curta na conversa e devolve `null`.
 */
export async function requestAgentWork(ctx: HubCtx, req: AgentWorkRequest): Promise<JobRow | null> {
  const db = ctx.env.DB;
  const { agent } = req;
  let blocked: string | null = null;
  if (agent.status === "paused") {
    blocked = `${agent.name} (@${agent.handle}) está pausado e não vai responder agora.`;
  } else if (!(await canTalkTo(db, agent, req.userId))) {
    blocked = agent.is_assistant
      ? `${agent.name} é um assistente pessoal e só responde a quem é dono dele.`
      : `Você não tem permissão para falar com ${agent.name} (@${agent.handle}).`;
  } else if ((await budgetState(db, agent)).exhausted) {
    blocked = `${agent.name} (@${agent.handle}) atingiu o orçamento do mês e não vai responder até o próximo período.`;
  }
  if (blocked) {
    await postSystemMessage(ctx, req.channel, blocked, req.threadRootId);
    return null;
  }
  return createJob(ctx, {
    agent,
    origin: "user",
    prompt: req.prompt,
    channelId: req.channel.id,
    threadRootId: req.threadRootId,
    triggerMessageId: req.triggerMessageId,
    requestedByUserId: req.userId,
  });
}

/** Volta um job `failed` para a fila. */
export async function retryJob(ctx: HubCtx, job: JobRow): Promise<JobRow | null> {
  const changed = await run(
    ctx.env.DB,
    `UPDATE jobs SET status = 'queued', attempts = 0, runner_id = NULL, runner_user_id = NULL, lease_expires_at = NULL,
       error = NULL, error_code = NULL, finished_at = NULL, started_at = NULL, no_runner_notified_at = NULL
     WHERE workspace_id = ? AND id = ? AND status = 'failed'`,
    ctx.wsId,
    job.id,
  );
  if (changed === 0) return null;
  const updated = (await getJobRow(ctx.env.DB, ctx.wsId, job.id))!;
  await publishJob(ctx, updated);
  await ctx.rt.pump();
  return updated;
}

/** Cancela um job ainda não terminado; avisa o runner se já tinha sido entregue. */
export async function cancelJob(ctx: HubCtx, job: JobRow): Promise<JobRow | null> {
  const now = Date.now();
  const changed = await run(
    ctx.env.DB,
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, lease_expires_at = NULL
     WHERE workspace_id = ? AND id = ? AND status IN ('awaiting_approval','queued','assigned','running')`,
    now,
    ctx.wsId,
    job.id,
  );
  if (changed === 0) return null;
  if (job.runner_id && (job.status === "assigned" || job.status === "running")) {
    await ctx.rt.cancelOnRunner(job.id, job.runner_id);
  }
  const pending = await first<ApprovalRow>(
    ctx.env.DB,
    "SELECT * FROM approvals WHERE workspace_id = ? AND job_id = ? AND status = 'pending'",
    ctx.wsId,
    job.id,
  );
  if (pending) {
    await run(
      ctx.env.DB,
      `UPDATE approvals SET status = 'rejected', decided_at = ?, decision_note = 'Job cancelado.'
       WHERE workspace_id = ? AND id = ?`,
      now,
      ctx.wsId,
      pending.id,
    );
    await publishApproval(ctx, { ...pending, status: "rejected", decided_at: now, decision_note: "Job cancelado." });
  }
  const updated = (await getJobRow(ctx.env.DB, ctx.wsId, job.id))!;
  await publishJob(ctx, updated);
  await ctx.rt.pump();
  return updated;
}
