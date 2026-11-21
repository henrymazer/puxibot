import {
  currentPeriod,
  NATIVE_TOOLS,
  type AgentDTO,
  type AgentUsageDTO,
  type ToolLevel,
} from "@puxibot/shared";
import { all, first, newId, placeholders, run, stmt } from "../lib/db";
import { nextCronRun } from "../lib/cron";
import { conflict, notFound } from "../lib/errors";
import type { HubCtx } from "./context";
import { findOrCreateDm } from "./channels";
import { links, notify } from "./notify";
import { toAgentDTO, type AgentRow } from "./rows";

export async function getAgentRow(db: D1Database, wsId: string, agentId: string): Promise<AgentRow | null> {
  return first<AgentRow>(db, "SELECT * FROM agents WHERE workspace_id = ? AND id = ?", wsId, agentId);
}

export async function requireAgentRow(db: D1Database, wsId: string, agentId: string): Promise<AgentRow> {
  const row = await getAgentRow(db, wsId, agentId);
  if (!row) throw notFound("Agente não encontrado.");
  return row;
}

export async function getAgentsByHandles(db: D1Database, wsId: string, handles: string[]): Promise<AgentRow[]> {
  if (handles.length === 0) return [];
  return all<AgentRow>(
    db,
    `SELECT * FROM agents WHERE workspace_id = ? AND handle IN (${placeholders(handles.length)})`,
    wsId,
    ...handles,
  );
}

export async function allowedUserIds(db: D1Database, agentId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(db, "SELECT user_id FROM agent_access WHERE agent_id = ?", agentId);
  return rows.map((r) => r.user_id);
}

export async function toolPerms(db: D1Database, agentId: string): Promise<Record<string, ToolLevel>> {
  const rows = await all<{ tool: string; level: ToolLevel }>(
    db,
    "SELECT tool, level FROM agent_tool_perms WHERE agent_id = ?",
    agentId,
  );
  return permsFromRows(rows);
}

function permsFromRows(rows: { tool: string; level: ToolLevel }[]): Record<string, ToolLevel> {
  const perms: Record<string, ToolLevel> = {};
  for (const t of NATIVE_TOOLS) perms[t] = "none";
  for (const r of rows) perms[r.tool] = r.level;
  return perms;
}

/** Estado `activity` de cada agente, calculado a partir dos jobs. */
export async function computeActivity(db: D1Database, wsId: string, agentIds: string[]) {
  const result = new Map<string, AgentDTO["activity"]>();
  if (agentIds.length === 0) return result;
  const active = await all<{ agent_id: string; status: string }>(
    db,
    `SELECT DISTINCT agent_id, status FROM jobs
     WHERE workspace_id = ? AND status IN ('awaiting_approval','queued','assigned','running')
       AND agent_id IN (${placeholders(agentIds.length)})`,
    wsId,
    ...agentIds,
  );
  const last = await all<{ agent_id: string; status: string }>(
    db,
    `SELECT agent_id, status FROM (
       SELECT agent_id, status, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY finished_at DESC) AS rn
       FROM jobs WHERE workspace_id = ? AND status IN ('done','failed') AND finished_at IS NOT NULL
         AND agent_id IN (${placeholders(agentIds.length)})
     ) WHERE rn = 1`,
    wsId,
    ...agentIds,
  );
  for (const id of agentIds) {
    const statuses = new Set(active.filter((a) => a.agent_id === id).map((a) => a.status));
    let activity: AgentDTO["activity"] = "idle";
    if (statuses.has("running") || statuses.has("assigned")) activity = "working";
    else if (statuses.has("awaiting_approval")) activity = "waiting_approval";
    else if (statuses.has("queued")) activity = "queued_no_runner";
    else if (last.find((l) => l.agent_id === id)?.status === "failed") activity = "error";
    result.set(id, activity);
  }
  return result;
}

export async function agentsToDTO(db: D1Database, wsId: string, rows: AgentRow[]): Promise<AgentDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);
  const [access, perms, skills, activity] = await Promise.all([
    all<{ agent_id: string; user_id: string }>(db, `SELECT agent_id, user_id FROM agent_access WHERE agent_id IN (${ph})`, ...ids),
    all<{ agent_id: string; tool: string; level: ToolLevel }>(
      db,
      `SELECT agent_id, tool, level FROM agent_tool_perms WHERE agent_id IN (${ph})`,
      ...ids,
    ),
    all<{ agent_id: string; skill_id: string }>(db, `SELECT agent_id, skill_id FROM agent_skills WHERE agent_id IN (${ph})`, ...ids),
    computeActivity(db, wsId, ids),
  ]);
  return rows.map((r) =>
    toAgentDTO(r, {
      allowedUserIds: access.filter((a) => a.agent_id === r.id).map((a) => a.user_id),
      toolPerms: permsFromRows(perms.filter((p) => p.agent_id === r.id)),
      skillIds: skills.filter((s) => s.agent_id === r.id).map((s) => s.skill_id),
      activity: activity.get(r.id) ?? "idle",
    }),
  );
}

export async function listAgents(db: D1Database, wsId: string): Promise<AgentDTO[]> {
  const rows = await all<AgentRow>(
    db,
    "SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_assistant, name COLLATE NOCASE",
    wsId,
  );
  return agentsToDTO(db, wsId, rows);
}

export async function getAgentDTO(db: D1Database, wsId: string, agentId: string): Promise<AgentDTO> {
  const row = await requireAgentRow(db, wsId, agentId);
  const [dto] = await agentsToDTO(db, wsId, [row]);
  return dto!;
}

export async function publishAgent(ctx: HubCtx, agentId: string): Promise<AgentDTO> {
  const agent = await getAgentDTO(ctx.env.DB, ctx.wsId, agentId);
  await ctx.rt.publish({ type: "agent.upserted", agent }, null);
  return agent;
}

/** "Quem pode falar": workspace = todos; restricted = responsável + lista; owner = só o responsável. */
export async function canTalkTo(db: D1Database, agent: AgentRow, userId: string): Promise<boolean> {
  if (agent.owner_user_id === userId) return true;
  if (agent.is_assistant === 1) return false;
  if (agent.access_mode === "workspace") return true;
  if (agent.access_mode === "owner") return false;
  const row = await first(db, "SELECT 1 AS one FROM agent_access WHERE agent_id = ? AND user_id = ?", agent.id, userId);
  return row != null;
}

// ---------- Handles ----------
export function slugify(text: string, max = 24): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export async function handleTaken(db: D1Database, wsId: string, handle: string): Promise<boolean> {
  return (await first(db, "SELECT 1 AS one FROM agents WHERE workspace_id = ? AND handle = ?", wsId, handle)) != null;
}

export async function uniqueHandle(db: D1Database, wsId: string, base: string): Promise<string> {
  const clean = base.slice(0, 28);
  if (!(await handleTaken(db, wsId, clean))) return clean;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${clean}-${i}`;
    if (!(await handleTaken(db, wsId, candidate))) return candidate;
  }
  return `${clean}-${crypto.randomUUID().slice(0, 4)}`;
}

// ---------- Criação ----------
export interface CreateAgentInput {
  handle: string;
  name: string;
  role?: string | null;
  description?: string | null;
  instructions?: string;
  sectorId?: string | null;
  ownerUserId: string;
  isAssistant?: boolean;
  accessMode?: AgentDTO["accessMode"];
  avatarColor?: string | null;
  avatarAccessory?: string | null;
}

const AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

export async function createAgent(ctx: HubCtx, input: CreateAgentInput): Promise<AgentDTO> {
  const db = ctx.env.DB;
  if (await handleTaken(db, ctx.wsId, input.handle)) throw conflict(`O handle @${input.handle} já está em uso.`, "handle_taken");
  const id = newId();
  const now = Date.now();
  const color = input.avatarColor ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
  await db.batch([
    stmt(
      db,
      `INSERT INTO agents (id, workspace_id, handle, name, role, description, instructions, avatar_color, avatar_accessory,
         sector_id, owner_user_id, is_assistant, access_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ctx.wsId,
      input.handle,
      input.name,
      input.role ?? null,
      input.description ?? null,
      input.instructions ?? "",
      color,
      input.avatarAccessory ?? null,
      input.sectorId ?? null,
      input.ownerUserId,
      input.isAssistant ? 1 : 0,
      input.accessMode ?? "workspace",
      now,
      now,
    ),
    // Permissões nativas padrão: todas `write`.
    ...NATIVE_TOOLS.map((tool) =>
      stmt(db, "INSERT INTO agent_tool_perms (agent_id, tool, level) VALUES (?, ?, 'write')", id, tool),
    ),
  ]);
  return publishAgent(ctx, id);
}

/**
 * Assistente pessoal: handle `assistente-<primeiro nome>`, acesso só do dono, DM com o dono
 * e rotina `daily_summary` às 9h (o agendamento é feito pelo módulo de rotinas).
 */
export async function createPersonalAssistant(ctx: HubCtx, userId: string): Promise<AgentDTO> {
  const db = ctx.env.DB;
  const existing = await first<{ id: string }>(
    db,
    "SELECT id FROM agents WHERE workspace_id = ? AND owner_user_id = ? AND is_assistant = 1",
    ctx.wsId,
    userId,
  );
  if (existing) return getAgentDTO(db, ctx.wsId, existing.id);
  const user = await first<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", userId);
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] ?? "";
  const handle = await uniqueHandle(db, ctx.wsId, `assistente-${slugify(firstName, 16) || "pessoa"}`);
  const agent = await createAgent(ctx, {
    handle,
    name: firstName ? `Assistente de ${firstName}` : "Assistente",
    role: "Assistente pessoal",
    description: "Secretário pessoal: cria agentes, manda recados, lembra prazos e faz o resumo diário.",
    instructions:
      "Você é o assistente pessoal de " +
      (user?.name ?? "uma pessoa do time") +
      ". Age com as permissões dessa pessoa: pode criar agentes, mandar recados e lembrar prazos. " +
      "Sempre deixe claro que a ação veio do assistente. Responda em português, de forma curta e direta.",
    ownerUserId: userId,
    isAssistant: true,
    accessMode: "owner",
  });
  const { channel } = await findOrCreateDm(db, ctx.wsId, { type: "user", id: userId }, { type: "agent", id: agent.id }, userId);
  const now = Date.now();
  await run(
    db,
    `INSERT INTO routines (id, workspace_id, agent_id, name, prompt, cron, timezone, channel_id, enabled, kind,
       next_run_at, last_run_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'daily_summary', ?, NULL, ?, ?)`,
    newId(),
    ctx.wsId,
    agent.id,
    "Resumo diário",
    "Resumo das últimas 24 h: tarefas concluídas, jobs que falharam e o que está esperando por mim.",
    DAILY_SUMMARY_CRON,
    DAILY_SUMMARY_TZ,
    channel.id,
    nextCronRun(DAILY_SUMMARY_CRON, DAILY_SUMMARY_TZ, now),
    userId,
    now,
  );
  // Acorda o WorkspaceHub para agendar o alarme do resumo.
  await ctx.rt.pump();
  return agent;
}

export const DAILY_SUMMARY_CRON = "0 9 * * *";
export const DAILY_SUMMARY_TZ = "America/Sao_Paulo";

// ---------- Orçamento ----------
export function periodRange(period: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error("período inválido");
  const y = Number(match[1]);
  const m = Number(match[2]);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}

/** Jobs que contam no orçamento: todos do período, menos cancelados e os que esperam aprovação. */
const COUNTED_JOB = "status NOT IN ('cancelled','awaiting_approval')";

export async function agentUsage(db: D1Database, wsId: string, agentId: string, period = currentPeriod()): Promise<AgentUsageDTO> {
  const { start, end } = periodRange(period);
  const totals = await first<{ runs: number; input: number | null; output: number | null }>(
    db,
    `SELECT COUNT(*) AS runs, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM jobs
     WHERE workspace_id = ? AND agent_id = ? AND created_at >= ? AND created_at < ? AND ${COUNTED_JOB}`,
    wsId,
    agentId,
    start,
    end,
  );
  const byUser = await all<{ user_id: string; runs: number; tokens: number }>(
    db,
    `SELECT runner_user_id AS user_id, COUNT(*) AS runs, SUM(input_tokens + output_tokens) AS tokens FROM jobs
     WHERE workspace_id = ? AND agent_id = ? AND created_at >= ? AND created_at < ? AND ${COUNTED_JOB}
       AND runner_user_id IS NOT NULL
     GROUP BY runner_user_id ORDER BY runs DESC`,
    wsId,
    agentId,
    start,
    end,
  );
  return {
    period,
    runs: totals?.runs ?? 0,
    inputTokens: totals?.input ?? 0,
    outputTokens: totals?.output ?? 0,
    byRunnerUser: byUser.map((u) => ({ userId: u.user_id, runs: u.runs, tokens: u.tokens ?? 0 })),
  };
}

export interface BudgetState {
  /** Maior fração usada entre execuções e tokens (0 quando não há limite). */
  ratio: number;
  exhausted: boolean;
}

export async function budgetState(db: D1Database, agent: AgentRow): Promise<BudgetState> {
  if (agent.budget_runs_month == null && agent.budget_tokens_month == null) return { ratio: 0, exhausted: false };
  const usage = await agentUsage(db, agent.workspace_id, agent.id);
  const tokens = usage.inputTokens + usage.outputTokens;
  let ratio = 0;
  let exhausted = false;
  if (agent.budget_runs_month != null) {
    ratio = Math.max(ratio, agent.budget_runs_month > 0 ? usage.runs / agent.budget_runs_month : 1);
    if (usage.runs >= agent.budget_runs_month) exhausted = true;
  }
  if (agent.budget_tokens_month != null) {
    ratio = Math.max(ratio, agent.budget_tokens_month > 0 ? tokens / agent.budget_tokens_month : 1);
    if (tokens >= agent.budget_tokens_month) exhausted = true;
  }
  return { ratio, exhausted };
}

/** Ao passar de 80% do orçamento, avisa o responsável uma única vez por período. */
export async function maybeWarnBudget(ctx: HubCtx, agentId: string): Promise<void> {
  const agent = await getAgentRow(ctx.env.DB, ctx.wsId, agentId);
  if (!agent) return;
  const period = currentPeriod();
  if (agent.budget_warned_period === period) return;
  const state = await budgetState(ctx.env.DB, agent);
  if (state.ratio < 0.8) return;
  const claimed = await run(
    ctx.env.DB,
    `UPDATE agents SET budget_warned_period = ? WHERE workspace_id = ? AND id = ?
       AND (budget_warned_period IS NULL OR budget_warned_period <> ?)`,
    period,
    ctx.wsId,
    agent.id,
    period,
  );
  if (claimed === 0) return;
  await notify(ctx, {
    userId: agent.owner_user_id,
    kind: "budget",
    title: `${agent.name} já usou ${Math.min(100, Math.round(state.ratio * 100))}% do orçamento do mês`,
    body: state.exhausted ? "O orçamento acabou; novos pedidos ficam bloqueados até o próximo mês." : null,
    link: links.agent(ctx.wsId, agent.id),
  });
}

export function parseCallable(agent: AgentRow): string[] {
  try {
    const v = JSON.parse(agent.callable_agents_json || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
