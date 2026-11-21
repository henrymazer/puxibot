/** Resumo da tela inicial: o que precisa de você, atividade recente e suas tarefas. Testado em summary.test.ts. */
import type { AgentDTO, ApprovalDTO, JobDTO, RunnerDTO, TaskDTO } from "@puxibot/shared";

const DAY = 24 * 3600_000;
const FAILED_WINDOW = 3 * DAY;

/** Lista buscada + atualizações em tempo real (a do tempo real vale mais). */
export function mergeJobs(fetched: JobDTO[], live: JobDTO[]): JobDTO[] {
  const map = new Map<string, JobDTO>();
  for (const j of fetched) map.set(j.id, j);
  for (const j of live) map.set(j.id, j);
  return [...map.values()];
}

const when = (j: JobDTO) => j.finishedAt ?? j.startedAt ?? j.createdAt;

export interface HomeInput {
  jobs: JobDTO[];
  approvals: ApprovalDTO[];
  runners: RunnerDTO[];
  agents: AgentDTO[];
  myUserId: string | null;
  admin: boolean;
  now: number;
}

export interface HomeSummary {
  approvals: ApprovalDTO[];
  failed: JobDTO[];
  /** null quando há computador seu ligado ou nada depende dele. */
  runnerWarning: { hasRunner: boolean; waiting: number; ownedAgents: number } | null;
}

function summarize(i: HomeInput): HomeSummary {
  const ownedAgents = new Set(i.agents.filter((a) => a.ownerUserId === i.myUserId).map((a) => a.id));
  const concernsMe = (j: JobDTO) => j.requestedByUserId === i.myUserId || ownedAgents.has(j.agentId);
  const approvals = i.approvals
    .filter((a) => a.status === "pending" && (a.approverUserId === i.myUserId || i.admin))
    .sort((a, b) => b.createdAt - a.createdAt);
  const failed = i.jobs
    .filter((j) => j.status === "failed" && concernsMe(j) && i.now - when(j) <= FAILED_WINDOW)
    .sort((a, b) => when(b) - when(a))
    .slice(0, 5);
  const mine = i.runners.filter((r) => r.userId === i.myUserId);
  const waiting = i.jobs.filter((j) => j.status === "queued" && j.waitingForRunner && concernsMe(j)).length;
  const runnerWarning =
    mine.some((r) => r.online) || (waiting === 0 && ownedAgents.size === 0)
      ? null
      : { hasRunner: mine.length > 0, waiting, ownedAgents: ownedAgents.size };
  return { approvals, failed, runnerWarning };
}

function recentActivity(jobs: JobDTO[], n: number): JobDTO[] {
  return jobs
    .filter((j) => j.status === "running" || j.status === "assigned" || j.status === "done" || j.status === "failed")
    .sort((a, b) => when(b) - when(a))
    .slice(0, n);
}

const PRIORITY = { high: 0, medium: 1, low: 2 } as const;
const STATUS = { doing: 0, review: 1, todo: 2, done: 3 } as const;

function myTasks(tasks: TaskDTO[], myUserId: string | null, n: number): { items: TaskDTO[]; more: number } {
  const mine = tasks
    .filter((t) => t.status !== "done" && t.assignee?.type === "user" && t.assignee.id === myUserId)
    .sort((a, b) => STATUS[a.status] - STATUS[b.status] || PRIORITY[a.priority] - PRIORITY[b.priority] || a.position - b.position);
  return { items: mine.slice(0, n), more: Math.max(0, mine.length - n) };
}

export const summarizeHome = Object.assign(summarize, { recentActivity, myTasks });
