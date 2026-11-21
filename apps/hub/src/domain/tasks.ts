import { extractMentions, userHandle, type ActorRef, type TaskCommentDTO, type TaskDTO } from "@puxibot/shared";
import { all, first, newId, placeholders, run, stmt, type SqlValue } from "../lib/db";
import { notFound } from "../lib/errors";
import { actorName, likePattern, type Actor } from "./actor";
import { budgetState, canTalkTo, getAgentRow, getAgentsByHandles } from "./agents";
import type { HubCtx } from "./context";
import { createJob, getJobRow } from "./jobs";
import { jobChain, MAX_CONSULT_DEPTH } from "./consult";
import { links, notify } from "./notify";
import { toTaskCommentDTO, toTaskDTO, type AgentRow, type JobRow, type TaskCommentRow, type TaskRow } from "./rows";

export async function getTaskRow(db: D1Database, wsId: string, id: string): Promise<TaskRow | null> {
  return first<TaskRow>(db, "SELECT * FROM tasks WHERE workspace_id = ? AND id = ?", wsId, id);
}

export async function requireTask(db: D1Database, wsId: string, id: string): Promise<TaskRow> {
  const row = await getTaskRow(db, wsId, id);
  if (!row) throw notFound("Tarefa não encontrada.");
  return row;
}

export async function requireTaskByNumber(db: D1Database, wsId: string, number: number): Promise<TaskRow> {
  const row = await first<TaskRow>(db, "SELECT * FROM tasks WHERE workspace_id = ? AND number = ?", wsId, number);
  if (!row) throw notFound(`Tarefa #${number} não encontrada.`);
  return row;
}

export async function tasksToDTO(db: D1Database, rows: TaskRow[]): Promise<TaskDTO[]> {
  if (rows.length === 0) return [];
  const counts = await all<{ task_id: string; n: number }>(
    db,
    `SELECT task_id, COUNT(*) AS n FROM task_comments WHERE task_id IN (${placeholders(rows.length)}) GROUP BY task_id`,
    ...rows.map((r) => r.id),
  );
  return rows.map((r) => toTaskDTO(r, counts.find((c) => c.task_id === r.id)?.n ?? 0));
}

export async function taskDTO(db: D1Database, row: TaskRow): Promise<TaskDTO> {
  return (await tasksToDTO(db, [row]))[0]!;
}

export interface TaskFilters {
  statuses?: string[];
  assignee?: ActorRef | "none";
  project?: string;
  label?: string;
  q?: string;
  limit?: number;
}

export async function listTasks(db: D1Database, wsId: string, f: TaskFilters): Promise<TaskDTO[]> {
  let sql = "SELECT * FROM tasks WHERE workspace_id = ?";
  const params: SqlValue[] = [wsId];
  if (f.statuses?.length) {
    sql += ` AND status IN (${placeholders(f.statuses.length)})`;
    params.push(...f.statuses);
  }
  if (f.assignee === "none") sql += " AND assignee_id IS NULL";
  else if (f.assignee) {
    sql += " AND assignee_type = ? AND assignee_id = ?";
    params.push(f.assignee.type, f.assignee.id);
  }
  if (f.project) {
    sql += " AND project = ?";
    params.push(f.project);
  }
  if (f.label) {
    sql += " AND EXISTS (SELECT 1 FROM json_each(tasks.labels_json) WHERE value = ?)";
    params.push(f.label);
  }
  if (f.q) {
    sql += " AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR CAST(number AS TEXT) = ?)";
    params.push(likePattern(f.q), likePattern(f.q), f.q.replace(/^#/, ""));
  }
  sql += " ORDER BY status, position, number LIMIT ?";
  params.push(Math.min(Math.max(f.limit ?? 500, 1), 1000));
  return tasksToDTO(db, await all<TaskRow>(db, sql, ...params));
}

export async function publishTask(ctx: HubCtx, row: TaskRow): Promise<TaskDTO> {
  const dto = await taskDTO(ctx.env.DB, row);
  await ctx.rt.publish({ type: "task.upserted", task: dto }, null);
  return dto;
}

export interface TaskInput {
  title?: string;
  description?: string;
  status?: TaskDTO["status"];
  priority?: TaskDTO["priority"];
  labels?: string[];
  project?: string | null;
  assignee?: ActorRef | null;
  subtasks?: { id?: string | undefined; title: string; done: boolean }[];
  links?: TaskDTO["links"];
  position?: number;
  sourceMessageId?: string | null;
}

function normalizeSubtasks(list: NonNullable<TaskInput["subtasks"]>): TaskDTO["subtasks"] {
  return list.map((s) => ({ id: s.id || newId().slice(0, 8), title: s.title, done: s.done }));
}

async function assertAssignee(db: D1Database, wsId: string, a: ActorRef | null | undefined): Promise<void> {
  if (!a) return;
  const sql =
    a.type === "user"
      ? "SELECT 1 AS one FROM members WHERE workspace_id = ? AND user_id = ?"
      : "SELECT 1 AS one FROM agents WHERE workspace_id = ? AND id = ?";
  if (!(await first(db, sql, wsId, a.id))) throw notFound(a.type === "user" ? "Pessoa responsável não encontrada." : "Agente responsável não encontrado.");
}

async function nextPosition(db: D1Database, wsId: string, status: string): Promise<number> {
  const row = await first<{ p: number | null }>(db, "SELECT MAX(position) AS p FROM tasks WHERE workspace_id = ? AND status = ?", wsId, status);
  return (row?.p ?? 0) + 1;
}

/** Cria a tarefa com número sequencial atômico (incremento e inserção na mesma transação). */
export async function createTask(ctx: HubCtx, actor: Actor, input: TaskInput & { title: string }): Promise<TaskDTO> {
  const db = ctx.env.DB;
  await assertAssignee(db, ctx.wsId, input.assignee);
  const id = newId();
  const now = Date.now();
  const status = input.status ?? "todo";
  const position = input.position ?? (await nextPosition(db, ctx.wsId, status));
  await db.batch([
    stmt(db, "UPDATE workspaces SET task_seq = task_seq + 1 WHERE id = ?", ctx.wsId),
    stmt(
      db,
      `INSERT INTO tasks (id, workspace_id, number, title, description, status, priority, labels_json, project,
         assignee_type, assignee_id, subtasks_json, links_json, source_message_id, created_by_type, created_by_id,
         position, created_at, updated_at, on_behalf_of_user_id)
       VALUES (?, ?, (SELECT task_seq FROM workspaces WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ctx.wsId,
      ctx.wsId,
      input.title,
      input.description ?? "",
      status,
      input.priority ?? "medium",
      JSON.stringify(input.labels ?? []),
      input.project ?? null,
      input.assignee?.type ?? null,
      input.assignee?.id ?? null,
      JSON.stringify(normalizeSubtasks(input.subtasks ?? [])),
      JSON.stringify(input.links ?? []),
      input.sourceMessageId ?? null,
      actor.ref.type,
      actor.ref.id,
      position,
      now,
      now,
      actor.onBehalfOfUserId,
    ),
  ]);
  const row = (await getTaskRow(db, ctx.wsId, id))!;
  const dto = await publishTask(ctx, row);
  if (input.assignee) await onAssigned(ctx, actor, row, input.assignee);
  return dto;
}

const COLUMNS: Record<string, string> = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  project: "project",
  position: "position",
  sourceMessageId: "source_message_id",
};

export async function updateTask(ctx: HubCtx, actor: Actor, task: TaskRow, input: TaskInput): Promise<TaskDTO> {
  const db = ctx.env.DB;
  if (input.assignee !== undefined) await assertAssignee(db, ctx.wsId, input.assignee);
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = (input as Record<string, unknown>)[field];
    if (value === undefined) continue;
    // `column` vem da constante COLUMNS, nunca da entrada.
    sets.push(`${column} = ?`);
    params.push(value as SqlValue);
  }
  if (input.status !== undefined && input.status !== task.status && input.position === undefined) {
    sets.push("position = ?");
    params.push(await nextPosition(db, ctx.wsId, input.status));
  }
  if (input.labels !== undefined) {
    sets.push("labels_json = ?");
    params.push(JSON.stringify(input.labels));
  }
  if (input.subtasks !== undefined) {
    sets.push("subtasks_json = ?");
    params.push(JSON.stringify(normalizeSubtasks(input.subtasks)));
  }
  if (input.links !== undefined) {
    sets.push("links_json = ?");
    params.push(JSON.stringify(input.links));
  }
  if (input.assignee !== undefined) {
    sets.push("assignee_type = ?", "assignee_id = ?");
    params.push(input.assignee?.type ?? null, input.assignee?.id ?? null);
  }
  if (actor.ref.type === "agent" && actor.onBehalfOfUserId) {
    sets.push("on_behalf_of_user_id = ?");
    params.push(actor.onBehalfOfUserId);
  }
  sets.push("updated_at = ?");
  params.push(Date.now());
  await run(db, `UPDATE tasks SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`, ...params, ctx.wsId, task.id);
  const row = (await getTaskRow(db, ctx.wsId, task.id))!;
  const dto = await publishTask(ctx, row);
  const changedAssignee =
    input.assignee && (input.assignee.type !== task.assignee_type || input.assignee.id !== task.assignee_id);
  if (changedAssignee && input.assignee) await onAssigned(ctx, actor, row, input.assignee);
  return dto;
}

export async function deleteTask(ctx: HubCtx, task: TaskRow): Promise<void> {
  await run(ctx.env.DB, "DELETE FROM tasks WHERE workspace_id = ? AND id = ?", ctx.wsId, task.id);
  await ctx.rt.publish({ type: "task.deleted", taskId: task.id }, null);
}

export async function listComments(db: D1Database, wsId: string, taskId: string): Promise<TaskCommentDTO[]> {
  const rows = await all<TaskCommentRow>(
    db,
    `SELECT tc.* FROM task_comments tc JOIN tasks t ON t.id = tc.task_id
     WHERE t.workspace_id = ? AND tc.task_id = ? ORDER BY tc.created_at, tc.id`,
    wsId,
    taskId,
  );
  return rows.map(toTaskCommentDTO);
}

/**
 * Comentário em tarefa. Menções `@handle` de agentes criam um job para cada agente citado (exceto o próprio autor);
 * menções de pessoas geram notificação.
 */
export async function addTaskComment(
  ctx: HubCtx,
  taskId: string,
  input: { author: ActorRef; body: string; onBehalfOfUserId?: string | null; triggerJobs?: boolean; actor?: Actor },
): Promise<TaskCommentDTO> {
  const db = ctx.env.DB;
  const task = await requireTask(db, ctx.wsId, taskId);
  const row: TaskCommentRow = {
    id: newId(),
    task_id: task.id,
    author_type: input.author.type,
    author_id: input.author.id,
    body: input.body,
    created_at: Date.now(),
    on_behalf_of_user_id: input.onBehalfOfUserId ?? null,
  };
  await db.batch([
    stmt(
      db,
      `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at, on_behalf_of_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.task_id,
      row.author_type,
      row.author_id,
      row.body,
      row.created_at,
      row.on_behalf_of_user_id,
    ),
    stmt(db, "UPDATE tasks SET updated_at = ? WHERE workspace_id = ? AND id = ?", row.created_at, ctx.wsId, task.id),
  ]);
  const fresh = (await getTaskRow(db, ctx.wsId, task.id))!;
  await publishTask(ctx, fresh);
  if (input.triggerJobs !== false && input.actor) {
    const handles = extractMentions(input.body);
    const agents = await getAgentsByHandles(db, ctx.wsId, handles);
    const who = await actorName(db, ctx.wsId, input.author);
    for (const agent of agents) {
      if (input.author.type === "agent" && agent.id === input.author.id) continue;
      await startTaskJob(ctx, input.actor, fresh, agent, `${who} mencionou você num comentário da tarefa:\n\n${input.body}`);
    }
    const rest = handles.filter((h) => !agents.some((a) => a.handle === h));
    if (rest.length) {
      const users = await all<{ id: string; email: string }>(
        db,
        "SELECT u.id, u.email FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?",
        ctx.wsId,
      );
      for (const u of users) {
        if (!rest.includes(userHandle(u)) || (input.author.type === "user" && input.author.id === u.id)) continue;
        await notify(ctx, {
          userId: u.id,
          kind: "mention",
          title: `${who} mencionou você na tarefa #${fresh.number}`,
          link: links.tasks(ctx.wsId, fresh.number),
        });
      }
    }
  }
  return toTaskCommentDTO(row);
}

function taskPrompt(task: TaskRow, reason: string): string {
  const subtasks = JSON.parse(task.subtasks_json || "[]") as { title: string; done: boolean }[];
  const lines = [
    `Tarefa #${task.number}: ${task.title}`,
    `Status: ${task.status} · Prioridade: ${task.priority}${task.project ? ` · Projeto: ${task.project}` : ""}`,
  ];
  if (task.description.trim()) lines.push("", "Descrição:", task.description);
  if (subtasks.length) lines.push("", "Subtarefas:", ...subtasks.map((s) => `- [${s.done ? "x" : " "}] ${s.title}`));
  lines.push(
    "",
    reason,
    "",
    `Use as ferramentas de tarefas (número ${task.number}) para atualizar status, subtarefas e links. Sua resposta final vira um comentário na tarefa.`,
  );
  return lines.join("\n");
}

/**
 * Cria o job de um agente para trabalhar numa tarefa. Pessoa: checa pausa, "quem pode falar" e orçamento
 * (bloqueado = sem job). Agente: job filho (origin 'agent'), sujeito à política de autoinício.
 */
export async function startTaskJob(ctx: HubCtx, actor: Actor, task: TaskRow, agent: AgentRow, reason: string): Promise<JobRow | null> {
  const db = ctx.env.DB;
  if (actor.ref.type === "agent" && actor.ref.id === agent.id) return null;
  if (agent.status === "paused") return null;
  if ((await budgetState(db, agent)).exhausted) return null;
  if (actor.ref.type === "user" && !(await canTalkTo(db, agent, actor.ref.id))) return null;
  if (actor.ref.type === "agent") {
    if (agent.is_assistant === 1) return null;
    // Agente agindo por uma pessoa não aciona quem ela não pode acionar ("quem pode falar").
    if (!(await canTalkTo(db, agent, actor.principalUserId))) return null;
    // Freio de laço: A atribui a B, B menciona A... O alvo não pode estar na cadeia, e a cadeia tem limite.
    if (actor.parentJobId) {
      const parent = await getJobRow(db, ctx.wsId, actor.parentJobId);
      if (parent) {
        const chain = await jobChain(db, ctx.wsId, parent);
        if (chain.agentIds.has(agent.id) || chain.depth + 1 > MAX_CONSULT_DEPTH) return null;
      }
    }
  }
  return createJob(ctx, {
    agent,
    origin: actor.ref.type === "user" ? "user" : "agent",
    prompt: taskPrompt(task, reason),
    requestedByUserId: actor.requestedByUserId,
    parentJobId: actor.parentJobId,
    taskId: task.id,
  });
}

async function onAssigned(ctx: HubCtx, actor: Actor, task: TaskRow, assignee: ActorRef): Promise<void> {
  const db = ctx.env.DB;
  const who = await actorName(db, ctx.wsId, actor.ref);
  if (assignee.type === "agent") {
    const agent = await getAgentRow(db, ctx.wsId, assignee.id);
    if (agent) await startTaskJob(ctx, actor, task, agent, `${who} atribuiu esta tarefa a você. Trabalhe nela.`);
  } else if (!(actor.ref.type === "user" && actor.ref.id === assignee.id)) {
    await notify(ctx, {
      userId: assignee.id,
      kind: "mention",
      title: `${who} atribuiu a tarefa #${task.number} a você`,
      link: links.tasks(ctx.wsId, task.number),
    });
  }
}

export const STALLED_MS = 24 * 60 * 60_000;

/** "Continuar todas": job para o agente responsável de cada tarefa `doing` parada há mais de 1 dia. */
export async function resumeStalledTasks(ctx: HubCtx, actor: Actor): Promise<{ tasks: TaskRow[]; jobs: JobRow[] }> {
  const db = ctx.env.DB;
  const stalled = await all<TaskRow>(
    db,
    `SELECT * FROM tasks WHERE workspace_id = ? AND status = 'doing' AND assignee_type = 'agent' AND updated_at < ?
     ORDER BY updated_at LIMIT 50`,
    ctx.wsId,
    Date.now() - STALLED_MS,
  );
  const jobs: JobRow[] = [];
  for (const task of stalled) {
    const agent = await getAgentRow(db, ctx.wsId, task.assignee_id!);
    if (!agent) continue;
    const busy = await first(
      db,
      "SELECT 1 AS one FROM jobs WHERE workspace_id = ? AND task_id = ? AND agent_id = ? AND status IN ('awaiting_approval','queued','assigned','running')",
      ctx.wsId,
      task.id,
      agent.id,
    );
    if (busy) continue;
    const days = Math.floor((Date.now() - task.updated_at) / 86_400_000);
    const job = await startTaskJob(ctx, actor, task, agent, `Esta tarefa está parada há ${days} dia(s). Continue de onde parou.`);
    if (job) jobs.push(job);
  }
  return { tasks: stalled, jobs };
}
