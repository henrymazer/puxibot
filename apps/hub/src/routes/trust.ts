/**
 * Regras de permissão por agente e registro de uso do workspace: o que cada trabalho fez nos conectores e
 * no navegador, com o motivo que liberou cada ação, tokens gastos e a projeção das rotinas.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { BROWSER_TOOL, currentPeriod, type UsageEntryDTO, type UsageSummaryDTO } from "@puxibot/shared";
import { all, first, placeholders, run, type SqlValue } from "../lib/db";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { nextCronRun } from "../lib/cron";
import { intParam, readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { periodRange, requireAgentRow } from "../domain/agents";
import type { AgentRow, JobRow, RoutineRow } from "../domain/rows";
import { toActionDTO, toTrustRuleDTO, upsertRule, type ActionRow, type TrustRuleRow } from "../domain/trust";
import { filterVisibleJobs, jobsWithVisibleContent } from "./agents";

export const trustRoutes = new Hono<WsEnv>();

// ---------- Regras ----------
async function managedAgent(c: Context<WsEnv>): Promise<AgentRow> {
  const agent = await requireAgentRow(c.env.DB, c.get("wsId"), c.req.param("id")!);
  if (agent.owner_user_id !== c.get("userId") && !isAdmin(c)) throw forbidden("Só o responsável pelo agente ou um admin vê e muda as regras dele.");
  return agent;
}

trustRoutes.get("/agents/:id/trust-rules", async (c) => {
  const agent = await managedAgent(c);
  const rows = await all<TrustRuleRow>(c.env.DB, "SELECT * FROM trust_rules WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at", c.get("wsId"), agent.id);
  return c.json({ items: rows.map(toTrustRuleDTO) });
});

trustRoutes.put("/agents/:id/trust-rules", async (c) => {
  const agent = await managedAgent(c);
  const body = await readBody(
    c,
    z.object({ connectorId: z.string().min(1).max(64), tool: z.string().trim().min(1).max(200).default("*"), effect: z.enum(["allow", "ask", "deny"]) }),
  );
  if (body.connectorId !== BROWSER_TOOL) {
    const conn = await first<{ owner_user_id: string }>(c.env.DB, "SELECT owner_user_id FROM connectors WHERE workspace_id = ? AND id = ?", c.get("wsId"), body.connectorId);
    if (!conn) throw notFound("Conector não encontrado.");
    // Liberar sem perguntar é decisão de quem conectou o serviço; restringir, qualquer responsável pode.
    if (body.effect === "allow" && conn.owner_user_id !== c.get("userId")) {
      throw forbidden("Só quem conectou este serviço pode liberar ações nele sem perguntar.", "connector_owner_required");
    }
  } else if (body.effect === "allow" && agent.owner_user_id !== c.get("userId")) {
    throw forbidden("Só o responsável pelo agente libera ações no navegador sem perguntar.", "owner_required");
  }
  const row = await upsertRule(c.env.DB, c.get("wsId"), { agentId: agent.id, connectorId: body.connectorId, tool: body.tool, effect: body.effect, userId: c.get("userId") });
  return c.json(toTrustRuleDTO(row));
});

trustRoutes.delete("/agents/:id/trust-rules/:rid", async (c) => {
  const agent = await managedAgent(c);
  const changed = await run(c.env.DB, "DELETE FROM trust_rules WHERE workspace_id = ? AND agent_id = ? AND id = ?", c.get("wsId"), agent.id, c.req.param("rid")!);
  if (changed === 0) throw notFound("Regra não encontrada.");
  return c.body(null, 204);
});

// ---------- Uso ----------
function usageRange(c: Context<WsEnv>): { start: number; end: number; period: string } {
  const period = c.req.query("period") || currentPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest("Período inválido; use AAAA-MM.");
  return { ...periodRange(period), period };
}

async function usageJobs(c: Context<WsEnv>, range: { start: number; end: number }, limit: number, before?: number): Promise<JobRow[]> {
  const params: SqlValue[] = [c.get("wsId"), range.start, Math.min(range.end, before ?? range.end)];
  let sql = "SELECT * FROM jobs WHERE workspace_id = ? AND created_at >= ? AND created_at < ?";
  const agentId = c.req.query("agentId");
  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  return filterVisibleJobs(c, await all<JobRow>(c.env.DB, sql, ...params));
}

async function actionsFor(db: D1Database, wsId: string, jobIds: string[]): Promise<Map<string, ActionRow[]>> {
  const out = new Map<string, ActionRow[]>();
  // D1 limita o número de parâmetros por consulta: em blocos.
  for (let i = 0; i < jobIds.length; i += 80) {
    const chunk = jobIds.slice(i, i + 80);
    const rows = await all<ActionRow>(db, `SELECT * FROM agent_actions WHERE workspace_id = ? AND job_id IN (${placeholders(chunk.length)}) ORDER BY created_at`, wsId, ...chunk);
    for (const r of rows) out.set(r.job_id, [...(out.get(r.job_id) ?? []), r]);
  }
  return out;
}

async function usageEntries(c: Context<WsEnv>, jobs: JobRow[]): Promise<UsageEntryDTO[]> {
  const withContent = await jobsWithVisibleContent(c, jobs);
  const actions = await actionsFor(c.env.DB, c.get("wsId"), jobs.filter((j) => withContent.has(j.id)).map((j) => j.id));
  return jobs.map((j) => ({
    jobId: j.id,
    agentId: j.agent_id,
    origin: j.origin,
    mode: j.mode ?? null,
    requestedByUserId: j.requested_by_user_id,
    routineId: j.routine_id,
    // Quem não pode ler a conversa vê que o trabalho existiu e quanto custou, não o pedido nem as ações.
    prompt: withContent.has(j.id) ? j.prompt.slice(0, 2000) : "",
    status: j.status,
    inputTokens: j.input_tokens,
    outputTokens: j.output_tokens,
    model: j.model,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    actions: (actions.get(j.id) ?? []).map(toActionDTO),
  }));
}

trustRoutes.get("/usage", async (c) => {
  const range = usageRange(c);
  const limit = intParam(c.req.query("limit"), 50, 1, 200);
  const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
  if (before !== undefined && !Number.isFinite(before)) throw badRequest("Cursor inválido.");
  const jobs = await usageJobs(c, range, limit, before);
  const last = jobs.at(-1);
  return c.json({ items: await usageEntries(c, jobs), nextBefore: jobs.length >= limit && last ? last.created_at : null });
});

trustRoutes.get("/usage/summary", async (c) => {
  const range = usageRange(c);
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const jobs = await usageJobs(c, range, 5000);
  const ids = jobs.map((j) => j.id);
  const actions = [...(await actionsFor(db, wsId, ids)).values()].flat();
  const byAgent = new Map<string, { runs: number; tokens: number }>();
  let input = 0;
  let output = 0;
  let background = 0;
  for (const j of jobs) {
    const tokens = j.input_tokens + j.output_tokens;
    input += j.input_tokens;
    output += j.output_tokens;
    if (j.origin === "routine" || j.mode === "prepare") background += tokens;
    const a = byAgent.get(j.agent_id) ?? { runs: 0, tokens: 0 };
    byAgent.set(j.agent_id, { runs: a.runs + 1, tokens: a.tokens + tokens });
  }

  // Projeção por rotina: média das últimas execuções terminadas × disparos previstos em 30 dias.
  const routineRows = await all<RoutineRow>(db, "SELECT * FROM routines WHERE workspace_id = ? AND enabled = 1 ORDER BY name COLLATE NOCASE", wsId);
  const visibleAgents = new Set(jobs.map((j) => j.agent_id));
  const owned = new Set((await all<{ id: string }>(db, "SELECT id FROM agents WHERE workspace_id = ? AND owner_user_id = ?", wsId, c.get("userId"))).map((r) => r.id));
  const routines: UsageSummaryDTO["routines"] = [];
  const now = Date.now();
  for (const r of routineRows) {
    if (!isAdmin(c) && !owned.has(r.agent_id) && !visibleAgents.has(r.agent_id)) continue;
    const stats = await first<{ runs: number; avg: number | null }>(
      db,
      `SELECT COUNT(*) AS runs, AVG(input_tokens + output_tokens) AS avg FROM (
         SELECT input_tokens, output_tokens FROM jobs WHERE workspace_id = ? AND routine_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 10)`,
      wsId,
      r.id,
    );
    let runsPerMonth = 0;
    let t = now;
    const horizon = now + 30 * 24 * 60 * 60_000;
    for (let i = 0; i < 3000; i++) {
      const next = nextCronRun(r.cron, r.timezone, t);
      if (next === null || next > horizon) break;
      runsPerMonth += 1;
      t = next;
    }
    const avg = Math.round(stats?.avg ?? 0);
    routines.push({ routineId: r.id, name: r.name, agentId: r.agent_id, runs: stats?.runs ?? 0, avgTokens: avg, runsPerMonth, projectedTokensMonth: avg * runsPerMonth });
  }

  const summary: UsageSummaryDTO = {
    period: range.period,
    runs: jobs.length,
    inputTokens: input,
    outputTokens: output,
    backgroundTokens: background,
    actions: {
      reads: actions.filter((a) => a.kind === "read" && a.decision === "allowed").length,
      writes: actions.filter((a) => a.kind === "write" && a.decision === "allowed").length,
      asked: actions.filter((a) => a.approval_id !== null).length,
      denied: actions.filter((a) => a.decision === "denied").length,
    },
    byAgent: [...byAgent.entries()].map(([agentId, v]) => ({ agentId, ...v })).sort((a, b) => b.tokens - a.tokens),
    routines,
  };
  return c.json(summary);
});

/** Valor de célula CSV. Texto que uma planilha leria como fórmula ganha um apóstrofo na frente. */
export function csvCell(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

trustRoutes.get("/usage/export", async (c) => {
  const range = usageRange(c);
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const entries = await usageEntries(c, await usageJobs(c, range, 5000));
  const agents = new Map((await all<{ id: string; name: string }>(db, "SELECT id, name FROM agents WHERE workspace_id = ?", wsId)).map((a) => [a.id, a.name]));
  const users = new Map(
    (await all<{ id: string; name: string }>(db, "SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?", wsId)).map((u) => [u.id, u.name]),
  );
  const origin = (e: UsageEntryDTO) => (e.mode === "prepare" ? "Preparação automática" : e.origin === "routine" ? "Rotina" : e.origin === "agent" ? "Outro agente" : e.origin === "user" ? "Pedido" : "Sistema");
  const header = ["quando", "agente", "origem", "quem pediu", "pedido", "status", "modelo", "tokens entrada", "tokens saída", "serviço", "ferramenta", "tipo", "decisão", "motivo", "resultado", "detalhes"];
  const lines = [header.map(csvCell).join(",")];
  for (const e of entries) {
    const base = [new Date(e.createdAt).toISOString(), agents.get(e.agentId) ?? e.agentId, origin(e), e.requestedByUserId ? (users.get(e.requestedByUserId) ?? "") : "", e.prompt.replace(/\s+/g, " ").slice(0, 300), e.status, e.model ?? "", e.inputTokens, e.outputTokens];
    if (e.actions.length === 0) lines.push([...base, "", "", "", "", "", "", ""].map(csvCell).join(","));
    for (const a of e.actions) {
      lines.push([...base, a.connectorName, a.tool, a.kind === "read" ? "leitura" : "ação", a.decision, a.reason, a.status, a.summary].map(csvCell).join(","));
    }
  }
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="puxibot-uso-${range.period}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
