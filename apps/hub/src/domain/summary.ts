import type { MessageCard, MessageDTO } from "@puxibot/shared";
import { all, first } from "../lib/db";
import { findOrCreateDm, getChannel } from "./channels";
import type { HubCtx } from "./context";
import { insertMessage } from "./messages";
import { links, notify } from "./notify";
import type { AgentRow, ApprovalRow, RoutineRow } from "./rows";

const DAY_MS = 24 * 60 * 60_000;
const MAX_ITEMS = 12;

export interface DailySummaryData {
  tasksDone: { number: number; title: string }[];
  failedJobs: { id: string; agentId: string; agentName: string; channelId: string | null }[];
  waitingRunner: { id: string; agentId: string; agentName: string; channelId: string | null }[];
  approvals: ApprovalRow[];
}

/**
 * Dados do resumo diário de uma pessoa nas últimas 24 h, sem IA:
 * - tarefas concluídas atribuídas a ela, a agentes dela ou criadas por ela;
 * - jobs que falharam de agentes dela ou pedidos por ela;
 * - o que espera por ela: aprovações pendentes, jobs parados por erro e jobs esperando um computador (runner).
 */
export async function collectDailySummary(db: D1Database, wsId: string, userId: string, now = Date.now()): Promise<DailySummaryData> {
  const since = now - DAY_MS;
  const [tasksDone, failedJobs, waitingRunner, approvals] = await Promise.all([
    all<{ number: number; title: string }>(
      db,
      `SELECT number, title FROM tasks
       WHERE workspace_id = ? AND status = 'done' AND updated_at >= ?
         AND ((assignee_type = 'user' AND assignee_id = ?)
           OR (assignee_type = 'agent' AND assignee_id IN (SELECT id FROM agents WHERE workspace_id = ? AND owner_user_id = ?))
           OR (created_by_type = 'user' AND created_by_id = ?))
       ORDER BY updated_at DESC LIMIT 50`,
      wsId,
      since,
      userId,
      wsId,
      userId,
      userId,
    ),
    all<{ id: string; agent_id: string; agent_name: string; channel_id: string | null }>(
      db,
      `SELECT j.id, j.agent_id, a.name AS agent_name, j.channel_id FROM jobs j JOIN agents a ON a.id = j.agent_id
       WHERE j.workspace_id = ? AND j.status = 'failed' AND COALESCE(j.finished_at, j.created_at) >= ?
         AND (a.owner_user_id = ? OR j.requested_by_user_id = ?)
       ORDER BY j.finished_at DESC LIMIT 50`,
      wsId,
      since,
      userId,
      userId,
    ),
    all<{ id: string; agent_id: string; agent_name: string; channel_id: string | null }>(
      db,
      `SELECT j.id, j.agent_id, a.name AS agent_name, j.channel_id FROM jobs j JOIN agents a ON a.id = j.agent_id
       WHERE j.workspace_id = ? AND j.status = 'queued' AND j.waiting_for_runner = 1
         AND (j.requested_by_user_id = ? OR (j.requested_by_user_id IS NULL AND a.owner_user_id = ?))
       ORDER BY j.created_at LIMIT 50`,
      wsId,
      userId,
      userId,
    ),
    all<ApprovalRow>(
      db,
      "SELECT * FROM approvals WHERE workspace_id = ? AND approver_user_id = ? AND status = 'pending' ORDER BY created_at LIMIT 50",
      wsId,
      userId,
    ),
  ]);
  const map = (r: { id: string; agent_id: string; agent_name: string; channel_id: string | null }) => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    channelId: r.channel_id,
  });
  return { tasksDone, failedJobs: failedJobs.map(map), waitingRunner: waitingRunner.map(map), approvals };
}

export function buildDailySummaryCards(wsId: string, d: DailySummaryData): { body: string; cards: MessageCard[] } {
  const waitingCount = d.approvals.length + d.failedJobs.length + d.waitingRunner.length;
  const items: { label: string; done: boolean; link?: string }[] = [];
  for (const a of d.approvals) items.push({ label: `Aprovar: ${a.title}`, done: false, link: links.approvals(wsId) });
  for (const j of d.failedJobs) {
    items.push({
      label: `${j.agentName} parou com um erro`,
      done: false,
      link: j.channelId ? links.channel(wsId, j.channelId) : links.agent(wsId, j.agentId),
    });
  }
  for (const j of d.waitingRunner) {
    items.push({
      label: `${j.agentName} está esperando um computador ligado`,
      done: false,
      link: j.channelId ? links.channel(wsId, j.channelId) : links.agent(wsId, j.agentId),
    });
  }
  const shown = items.slice(0, MAX_ITEMS);
  if (items.length > MAX_ITEMS) shown.push({ label: `…e mais ${items.length - MAX_ITEMS}`, done: false, link: links.approvals(wsId) });
  if (shown.length === 0) shown.push({ label: "Nada esperando por você", done: true });
  const doneLine = d.tasksDone.length
    ? `Concluídas: ${d.tasksDone
        .slice(0, 5)
        .map((t) => `#${t.number} ${t.title}`)
        .join(", ")}${d.tasksDone.length > 5 ? "…" : ""}.`
    : "Nenhuma tarefa concluída nas últimas 24 horas.";
  return {
    body: `Bom dia! Aqui está o seu resumo das últimas 24 horas.\n\n${doneLine}${waitingCount ? `\n\n${waitingCount} ${waitingCount === 1 ? "item precisa" : "itens precisam"} de você.` : ""}`,
    cards: [
      {
        type: "stats",
        title: "Últimas 24 horas",
        items: [
          { label: "Tarefas concluídas", value: String(d.tasksDone.length) },
          { label: "Jobs que falharam", value: String(d.failedJobs.length) },
          { label: "Esperando você", value: String(waitingCount) },
        ],
      },
      { type: "checklist", title: "Precisa de você", items: shown },
    ],
  };
}

/** Publica o resumo diário na DM do dono com o assistente (ou no canal da rotina). Funciona sem nenhum runner ligado. */
export async function postDailySummary(ctx: HubCtx, assistant: AgentRow, routine: RoutineRow): Promise<MessageDTO | null> {
  const db = ctx.env.DB;
  const ownerId = assistant.owner_user_id;
  const member = await first(db, "SELECT 1 AS one FROM members WHERE workspace_id = ? AND user_id = ?", ctx.wsId, ownerId);
  if (!member) return null;
  let channel = routine.channel_id ? await getChannel(db, ctx.wsId, routine.channel_id) : null;
  if (!channel) {
    channel = (await findOrCreateDm(db, ctx.wsId, { type: "user", id: ownerId }, { type: "agent", id: assistant.id }, ownerId)).channel;
  }
  const data = await collectDailySummary(db, ctx.wsId, ownerId);
  const { body, cards } = buildDailySummaryCards(ctx.wsId, data);
  const message = await insertMessage(ctx, { channel, author: { type: "agent", id: assistant.id }, body, cards });
  await notify(ctx, {
    userId: ownerId,
    kind: "dm",
    title: `${assistant.name} mandou o seu resumo diário`,
    link: links.channel(ctx.wsId, channel.id),
  });
  return message;
}
