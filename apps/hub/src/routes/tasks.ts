import { Hono, type Context } from "hono";
import { z } from "zod";
import { createTaskSchema, TASK_PRIORITIES, TASK_STATUSES, type ActorRef } from "@puxibot/shared";
import { badRequest, forbidden } from "../lib/errors";
import { readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { userActor } from "../domain/actor";
import { safeUrlSchema } from "../domain/cards";
import { toJobDTO } from "../domain/rows";
import {
  addTaskComment,
  createTask,
  deleteTask,
  listComments,
  listTasks,
  requireTask,
  resumeStalledTasks,
  taskDTO,
  updateTask,
} from "../domain/tasks";

/** /api/workspaces/:ws/tasks */
export const taskRoutes = new Hono<WsEnv>();

const actorSchema = z.object({ type: z.enum(["user", "agent"]), id: z.string().min(1) });
export const subtaskSchema = z.object({ id: z.string().max(40).optional(), title: z.string().min(1).max(300), done: z.boolean().default(false) });
export const linkSchema = z.object({ kind: z.enum(["pr", "issue", "url"]), label: z.string().max(200), url: safeUrlSchema });

const createSchema = createTaskSchema.extend({
  subtasks: z.array(subtaskSchema).max(100).optional(),
  links: z.array(linkSchema).max(50).optional(),
  position: z.number().optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labels: z.array(z.string().max(40)).max(10).optional(),
  project: z.string().max(60).nullable().optional(),
  assignee: actorSchema.nullable().optional(),
  subtasks: z.array(subtaskSchema).max(100).optional(),
  links: z.array(linkSchema).max(50).optional(),
  position: z.number().optional(),
  sourceMessageId: z.string().nullable().optional(),
});

function actor(c: Context<WsEnv>) {
  return userActor(c.get("userId"), isAdmin(c));
}

/** `assignee`: `user:<id>`, `agent:<id>`, `me` ou `none`. */
function parseAssignee(raw: string | undefined, userId: string): ActorRef | "none" | undefined {
  if (!raw) return undefined;
  if (raw === "none") return "none";
  if (raw === "me") return { type: "user", id: userId };
  const m = /^(user|agent):(.+)$/.exec(raw);
  if (!m) throw badRequest('Filtro "assignee" inválido; use user:<id>, agent:<id>, me ou none.');
  return { type: m[1] as "user" | "agent", id: m[2]! };
}

export function parseStatusList(raw: string | undefined, allowed: readonly string[], label: string): string[] | undefined {
  if (!raw) return undefined;
  const list = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  for (const s of list) if (!allowed.includes(s)) throw badRequest(`Status de ${label} inválido: ${s}.`);
  return list.length ? list : undefined;
}

taskRoutes.get("/tasks", async (c) => {
  const items = await listTasks(c.env.DB, c.get("wsId"), {
    statuses: parseStatusList(c.req.query("status"), TASK_STATUSES, "tarefa"),
    assignee: parseAssignee(c.req.query("assignee"), c.get("userId")),
    project: c.req.query("project") || undefined,
    label: c.req.query("label") || undefined,
    q: c.req.query("q") || undefined,
  });
  return c.json({ items });
});

taskRoutes.post("/tasks", async (c) => {
  const body = await readBody(c, createSchema);
  const task = await createTask(c.get("hub"), actor(c), {
    ...body,
    project: body.project ?? null,
    assignee: body.assignee ?? null,
    sourceMessageId: body.sourceMessageId ?? null,
  });
  return c.json(task, 201);
});

// Antes de /tasks/:id para não colidir.
taskRoutes.post("/tasks/resume-stalled", async (c) => {
  const { tasks, jobs } = await resumeStalledTasks(c.get("hub"), actor(c));
  return c.json({ stalled: tasks.length, items: jobs.map(toJobDTO) });
});

taskRoutes.get("/tasks/:id", async (c) => {
  const row = await requireTask(c.env.DB, c.get("wsId"), c.req.param("id"));
  return c.json(await taskDTO(c.env.DB, row));
});

taskRoutes.patch("/tasks/:id", async (c) => {
  const row = await requireTask(c.env.DB, c.get("wsId"), c.req.param("id"));
  const body = await readBody(c, patchSchema);
  return c.json(await updateTask(c.get("hub"), actor(c), row, body));
});

taskRoutes.delete("/tasks/:id", async (c) => {
  const row = await requireTask(c.env.DB, c.get("wsId"), c.req.param("id"));
  const isCreator = row.created_by_type === "user" && row.created_by_id === c.get("userId");
  if (!isCreator && !isAdmin(c)) throw forbidden("Só quem criou a tarefa ou um admin pode apagá-la.");
  await deleteTask(c.get("hub"), row);
  return c.body(null, 204);
});

taskRoutes.get("/tasks/:id/comments", async (c) => {
  const row = await requireTask(c.env.DB, c.get("wsId"), c.req.param("id"));
  return c.json({ items: await listComments(c.env.DB, c.get("wsId"), row.id) });
});

taskRoutes.post("/tasks/:id/comments", async (c) => {
  const row = await requireTask(c.env.DB, c.get("wsId"), c.req.param("id"));
  const body = await readBody(c, z.object({ body: z.string().trim().min(1).max(20_000) }));
  const a = actor(c);
  const comment = await addTaskComment(c.get("hub"), row.id, { author: a.ref, body: body.body, actor: a });
  return c.json(comment, 201);
});
