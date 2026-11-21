import { Hono } from "hono";
import { z } from "zod";
import { JOB_STATUSES } from "@puxibot/shared";
import { all, first, placeholders, run, type SqlValue } from "../lib/db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { getAgentRow } from "../domain/agents";
import { cancelJob, getJobRow, publishApproval, publishJob, retryJob } from "../domain/jobs";
import { toJobDTO, type ApprovalRow, type JobRow } from "../domain/rows";
import { filterVisibleJobs, jobDTOFor, jobsWithVisibleContent } from "./agents";
import { visibleApprovals } from "./workspaces";
import { parseStatusList } from "./tasks";

/** /api/workspaces/:ws/jobs e /approvals */
export const jobRoutes = new Hono<WsEnv>();

jobRoutes.get("/jobs", async (c) => {
  const statuses = parseStatusList(c.req.query("status"), JOB_STATUSES, "job");
  const agentId = c.req.query("agentId");
  const channelId = c.req.query("channelId");
  let sql = "SELECT * FROM jobs WHERE workspace_id = ?";
  const params: SqlValue[] = [c.get("wsId")];
  if (statuses) {
    sql += ` AND status IN (${placeholders(statuses.length)})`;
    params.push(...statuses);
  }
  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }
  if (channelId) {
    sql += " AND channel_id = ?";
    params.push(channelId);
  }
  sql += " ORDER BY created_at DESC LIMIT 200";
  const rows = await all<JobRow>(c.env.DB, sql, ...params);
  const visible = await filterVisibleJobs(c, rows);
  const withContent = await jobsWithVisibleContent(c, visible);
  return c.json({ items: visible.map((j) => jobDTOFor(j, withContent)) });
});

async function requireJob(db: D1Database, wsId: string, id: string): Promise<JobRow> {
  const job = await getJobRow(db, wsId, id);
  if (!job) throw notFound("Job não encontrado.");
  return job;
}

jobRoutes.post("/jobs/:id/cancel", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const job = await requireJob(db, wsId, c.req.param("id"));
  const agent = await getAgentRow(db, wsId, job.agent_id);
  if (job.requested_by_user_id !== userId && agent?.owner_user_id !== userId && !isAdmin(c)) {
    throw forbidden("Só quem pediu, o responsável pelo agente ou um admin cancela o job.");
  }
  const updated = await cancelJob(c.get("hub"), job);
  if (!updated) throw conflict("Este job já terminou.", "job_finished");
  return c.json(jobDTOFor(updated, await jobsWithVisibleContent(c, [updated])));
});

jobRoutes.post("/jobs/:id/retry", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const job = await requireJob(db, wsId, c.req.param("id"));
  const agent = await getAgentRow(db, wsId, job.agent_id);
  if (job.requested_by_user_id !== userId && agent?.owner_user_id !== userId && !isAdmin(c)) {
    throw forbidden("Só quem pediu, o responsável pelo agente ou um admin tenta de novo.");
  }
  if (job.status !== "failed") throw conflict("Só jobs que falharam podem ser tentados de novo.", "job_not_failed");
  const updated = await retryJob(c.get("hub"), job);
  if (!updated) throw conflict("Só jobs que falharam podem ser tentados de novo.", "job_not_failed");
  return c.json(jobDTOFor(updated, await jobsWithVisibleContent(c, [updated])));
});

// ---------- Aprovações ----------
jobRoutes.get("/approvals", async (c) => {
  const statuses = parseStatusList(c.req.query("status"), ["pending", "approved", "rejected"], "aprovação") ?? null;
  return c.json({ items: await visibleApprovals(c, statuses) });
});

const decideSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(1000).optional(),
});

jobRoutes.post("/approvals/:id/decide", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const hub = c.get("hub");
  const body = await readBody(c, decideSchema);
  const approval = await first<ApprovalRow>(db, "SELECT * FROM approvals WHERE workspace_id = ? AND id = ?", wsId, c.req.param("id"));
  if (!approval) throw notFound("Aprovação não encontrada.");
  if (approval.approver_user_id !== userId && !isAdmin(c)) throw forbidden("Só o responsável ou um admin decide esta aprovação.");
  const now = Date.now();
  const changed = await run(
    db,
    `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
     WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
    body.decision,
    userId,
    now,
    body.note ?? null,
    wsId,
    approval.id,
  );
  if (changed === 0) throw conflict("Esta aprovação já foi decidida.", "approval_decided");
  const decided: ApprovalRow = { ...approval, status: body.decision, decided_by: userId, decided_at: now, decision_note: body.note ?? null };
  const dto = await publishApproval(hub, decided);

  if (approval.kind === "job_start" && approval.job_id) {
    const nextStatus = body.decision === "approved" ? "queued" : "cancelled";
    const moved = await run(
      db,
      `UPDATE jobs SET status = ?, finished_at = ? WHERE workspace_id = ? AND id = ? AND status = 'awaiting_approval'`,
      nextStatus,
      nextStatus === "cancelled" ? now : null,
      wsId,
      approval.job_id,
    );
    if (moved > 0) {
      const job = (await getJobRow(db, wsId, approval.job_id))!;
      await publishJob(hub, job);
      if (nextStatus === "queued") await hub.rt.pump();
    }
  }
  return c.json(dto);
});
