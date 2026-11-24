/**
 * API de ferramentas (`/api/tool/*`), usada pelo servidor MCP do runner. Autenticada pelo token do job
 * (`requireJob`); o ator é o agente do job. Cada rota confere `agent_tool_perms` (read/write) e responde 403
 * `tool_permission_denied` com mensagem clara. Corpos e respostas seguem `apps/runner/src/mcp/tools.ts`.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { BROWSER_TOOL, LEARNED_SKILL_MAX_CHARS, LEARNED_SKILLS_PER_AGENT, extractMentions, handleSchema, MEMORY_REVIEW_MAX_ADD, MEMORY_REVIEW_MAX_CHARS, MEMORY_REVIEW_MAX_REMOVE, TASK_PRIORITIES, TASK_STATUSES, userHandle, type ActorRef, type NativeTool, type ToolLevel } from "@puxibot/shared";
import { all, first, newId, placeholders, run } from "../lib/db";
import { badRequest, forbidden, HttpError, notFound } from "../lib/errors";
import { intParam, readBody } from "../lib/validate";
import type { ToolEnv } from "../http/types";
import { agentActor, jobPrincipal, type Actor } from "../domain/actor";
import { cardsSchema } from "../domain/cards";
import { createAgent, publishAgent, requireAgentRow, toolPerms } from "../domain/agents";
import { findOrCreateDm } from "../domain/channels";
import { consultAgent, DEFAULT_WAIT_MS, requireAgentByHandle } from "../domain/consult";
import { fileContentResponse, listFiles, requireVisibleFile, uploadFromRequest } from "../domain/files";
import { getJobRow, jobAudience, publishApproval } from "../domain/jobs";
import { createMemory, deleteMemory, findQuote, getMemory, humanWords, listMemories } from "../domain/memories";
import { insertMessage, messagesToDTO } from "../domain/messages";
import { links, notify } from "../domain/notify";
import { assertRoutineChannel, assertValidSchedule, DEFAULT_TIMEZONE, insertRoutine } from "../domain/routines";
import { toApprovalDTO, toJobEventDTO, toRoutineDTO, toWikiPageDTO, type AgentRow, type ApprovalRow, type ChannelRow, type JobRow, type MessageRow } from "../domain/rows";
import { searchWorkspace } from "../domain/search";
import { addTaskComment, createTask, listTasks, requireTaskByNumber, updateTask } from "../domain/tasks";
import { agentCanSeeChannel, agentCanSeeChannelFor, findChannelByRef } from "../domain/visibility";
import { createPage, findPageByTitle, getPage, listTree, recordRead, updatePage } from "../domain/wiki";
import { actionState, checkAction, connectorLabel, finishAction, getAction } from "../domain/trust";
import { createSecretRequest, secretRequestSchema } from "../domain/secretRequests";
import { linkSchema, subtaskSchema } from "./tasks";

export const toolRoutes = new Hono<ToolEnv>();

// ---------- Contexto do agente ----------
interface ToolCtx {
  agent: AgentRow;
  job: JobRow;
  perms: Record<string, ToolLevel>;
  actor: Actor;
  /** Pessoa por quem o agente age neste job (quem pediu, ou o responsável). */
  principalUserId: string;
  wsId: string;
  db: D1Database;
}

async function tctx(c: Context<ToolEnv>): Promise<ToolCtx> {
  const claims = c.get("job");
  const db = c.env.DB;
  const [agent, job, perms] = await Promise.all([
    requireAgentRow(db, claims.workspaceId, claims.agentId),
    getJobRow(db, claims.workspaceId, claims.jobId),
    toolPerms(db, claims.agentId),
  ]);
  if (!job) throw new HttpError(401, "unauthorized", "Este job não existe mais.");
  const principalUserId = jobPrincipal(job, agent);
  // Quem responde pelo job saiu do workspace: o agente não age mais por ela.
  if (!(await first(db, "SELECT 1 AS one FROM members WHERE workspace_id = ? AND user_id = ?", claims.workspaceId, principalUserId))) {
    throw forbidden("Quem pediu este trabalho não faz mais parte do workspace.", "principal_not_member");
  }
  return {
    agent,
    job,
    perms,
    actor: agentActor(agent.id, { jobId: job.id, requestedByUserId: job.requested_by_user_id, principalUserId }),
    principalUserId,
    wsId: claims.workspaceId,
    db,
  };
}

const TOOL_LABELS: Record<NativeTool, string> = {
  messages: "mensagens",
  memory: "memória",
  tasks: "tarefas",
  wiki: "wiki",
  drive: "drive",
  agents: "agentes e time",
};

function requirePerm(t: ToolCtx, tool: NativeTool, level: "read" | "write"): void {
  // Preparação automática: o agente lê e guarda rascunhos no drive; não mexe em mais nada.
  if (level === "write" && t.job.mode === "prepare" && tool !== "drive") {
    throw forbidden(
      `Este trabalho é uma preparação automática: ${t.agent.name} só lê e rascunha, não altera ${TOOL_LABELS[tool]}. Guarde o rascunho no drive e avise na resposta.`,
      "prepare_read_only",
    );
  }
  const have = t.perms[tool] ?? "none";
  const ok = level === "read" ? have === "read" || have === "write" : have === "write";
  if (ok) return;
  const what = level === "read" ? "ler" : "alterar";
  const current = have === "none" ? "sem acesso" : "só leitura";
  throw forbidden(
    `${t.agent.name} não tem permissão para ${what} ${TOOL_LABELS[tool]} (está como "${current}" em ${tool}). ` +
      "O responsável pelo agente ou um admin pode liberar em Ferramentas e acesso.",
    "tool_permission_denied",
  );
}

function hasPerm(t: ToolCtx, tool: NativeTool, level: "read" | "write"): boolean {
  const have = t.perms[tool] ?? "none";
  return level === "read" ? have !== "none" : have === "write";
}

/**
 * Canal que o agente enxerga (nunca humansOnly nem privado de que não é membro) E que a pessoa por quem ele age
 * também enxerga: 404 genérico caso contrário. O canal do próprio job vale sempre (o pedido veio de lá).
 */
async function visibleChannel(t: ToolCtx, ref: string): Promise<ChannelRow> {
  const ch = await findChannelByRef(t.db, t.wsId, ref);
  const ok =
    ch &&
    (ch.id === t.job.channel_id
      ? await agentCanSeeChannel(t.db, ch, t.agent.id)
      : await agentCanSeeChannelFor(t.db, ch, t.agent.id, t.principalUserId));
  if (!ch || !ok) throw notFound(`Canal "${ref}" não encontrado (ou você não tem acesso a ele).`);
  return ch;
}

/** Pessoa do workspace por e-mail, nome exato ou parte do nome (precisa ser única). */
async function findUser(t: ToolCtx, ref: string): Promise<{ id: string; name: string; email: string }> {
  const people = await all<{ id: string; name: string; email: string }>(
    t.db,
    "SELECT u.id, u.name, u.email FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?",
    t.wsId,
  );
  const q = ref.trim().replace(/^@/, "").toLowerCase();
  const exact = people.filter((p) => p.email.toLowerCase() === q || p.id === ref || p.name.toLowerCase() === q || userHandle(p) === q);
  if (exact.length === 1) return exact[0]!;
  const partial = people.filter((p) => p.name.toLowerCase().includes(q));
  if (partial.length === 1 && exact.length === 0) return partial[0]!;
  if (exact.length + partial.length === 0) throw notFound(`Ninguém no workspace com nome ou e-mail "${ref}".`);
  const options = [...new Set([...exact, ...partial])].slice(0, 5).map((p) => `${p.name} <${p.email}>`).join(", ");
  throw badRequest(`"${ref}" corresponde a mais de uma pessoa: ${options}. Use o e-mail.`, "ambiguous_user");
}

async function resolveAssignee(t: ToolCtx, agentHandle?: string, userRef?: string): Promise<ActorRef | null | undefined> {
  if (agentHandle) return { type: "agent", id: (await requireAgentByHandle(t.db, t.wsId, agentHandle)).id };
  if (userRef) return { type: "user", id: (await findUser(t, userRef)).id };
  return undefined;
}

async function authorNames(db: D1Database, wsId: string, rows: MessageRow[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const users = [...new Set(rows.filter((r) => r.author_type === "user" && r.author_id).map((r) => r.author_id!))];
  const agents = [...new Set(rows.filter((r) => r.author_type === "agent" && r.author_id).map((r) => r.author_id!))];
  if (users.length) {
    for (const u of await all<{ id: string; name: string }>(db, `SELECT id, name FROM users WHERE id IN (${placeholders(users.length)})`, ...users)) {
      names.set(`user:${u.id}`, u.name);
    }
  }
  if (agents.length) {
    for (const a of await all<{ id: string; name: string; handle: string }>(
      db,
      `SELECT id, name, handle FROM agents WHERE workspace_id = ? AND id IN (${placeholders(agents.length)})`,
      wsId,
      ...agents,
    )) {
      names.set(`agent:${a.id}`, `${a.name} (@${a.handle})`);
    }
  }
  return names;
}

// ---------- Mensagens ----------
const sendSchema = z.object({
  body: z.string().min(1).max(20_000),
  channel: z.string().optional(),
  toUser: z.string().optional(),
  toAgent: z.string().optional(),
  threadRootId: z.string().optional(),
  cards: cardsSchema.optional(),
});

toolRoutes.post("/messages", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "messages", "write");
  const body = await readBody(c, sendSchema);
  const targets = [body.channel, body.toUser, body.toAgent].filter((x) => x && x.trim());
  if (targets.length !== 1) throw badRequest("Informe exatamente um destino: channel, toUser ou toAgent.");
  const me: ActorRef = { type: "agent", id: t.agent.id };
  let channel: ChannelRow;
  let dmUserId: string | null = null;
  if (body.channel) channel = await visibleChannel(t, body.channel);
  else if (body.toUser) {
    const user = await findUser(t, body.toUser);
    dmUserId = user.id;
    channel = (await findOrCreateDm(t.db, t.wsId, me, { type: "user", id: user.id }, null)).channel;
  } else {
    const other = await requireAgentByHandle(t.db, t.wsId, body.toAgent!);
    if (other.id === t.agent.id) throw badRequest("Você não pode mandar mensagem para si mesmo.");
    channel = (await findOrCreateDm(t.db, t.wsId, me, { type: "agent", id: other.id }, null)).channel;
  }
  if (body.threadRootId) {
    const root = await first<MessageRow>(t.db, "SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ? AND id = ?", t.wsId, channel.id, body.threadRootId);
    if (!root) throw notFound("Mensagem raiz da thread não encontrada neste canal.");
    if (root.thread_root_id) throw badRequest("Responda na mensagem raiz da thread.");
  }
  // Menções a pessoas viram notificação (menções a agentes não disparam jobs: use consultar_agente).
  const handles = extractMentions(body.body);
  const mentions: ActorRef[] = [];
  if (handles.length) {
    for (const a of await all<{ id: string; handle: string }>(
      t.db,
      `SELECT id, handle FROM agents WHERE workspace_id = ? AND handle IN (${placeholders(handles.length)})`,
      t.wsId,
      ...handles,
    )) {
      mentions.push({ type: "agent", id: a.id });
    }
    const users = await all<{ id: string; email: string }>(t.db, "SELECT u.id, u.email FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?", t.wsId);
    for (const u of users) if (handles.includes(userHandle(u))) mentions.push({ type: "user", id: u.id });
  }
  const hub = c.get("hub");
  const message = await insertMessage(hub, {
    channel,
    author: me,
    body: body.body,
    threadRootId: body.threadRootId ?? null,
    cards: body.cards ?? [],
    mentions,
    jobId: t.job.id,
    onBehalfOfUserId: t.job.requested_by_user_id,
  });
  const notified = new Set<string>();
  if (dmUserId) {
    notified.add(dmUserId);
    await notify(hub, { userId: dmUserId, kind: "dm", title: `${t.agent.name} mandou uma mensagem`, link: links.channel(t.wsId, channel.id) });
  }
  for (const m of mentions) {
    if (m.type !== "user" || notified.has(m.id)) continue;
    notified.add(m.id);
    await notify(hub, {
      userId: m.id,
      kind: "mention",
      title: channel.kind === "dm" ? `${t.agent.name} mencionou você` : `${t.agent.name} mencionou você em #${channel.name ?? "canal"}`,
      link: links.channel(t.wsId, channel.id),
    });
  }
  return c.json(message, 201);
});

toolRoutes.get("/messages", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "messages", "read");
  const ref = c.req.query("channel") || t.job.channel_id;
  if (!ref) throw badRequest("Informe o canal (este pedido não veio de uma conversa).");
  const channel = await visibleChannel(t, ref);
  const limit = intParam(c.req.query("limit"), 50, 1, 100);
  const before = intParam(c.req.query("before"), Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
  const threadRootId = c.req.query("threadRootId");
  const rows = await all<MessageRow>(
    t.db,
    `SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ? AND deleted_at IS NULL AND created_at < ?
       AND ${threadRootId ? "(thread_root_id = ? OR id = ?)" : "thread_root_id IS NULL"}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    t.wsId,
    channel.id,
    before,
    ...(threadRootId ? [threadRootId, threadRootId] : []),
    limit,
  );
  rows.reverse();
  const names = await authorNames(t.db, t.wsId, rows);
  const dtos = await messagesToDTO(t.db, t.wsId, rows);
  return c.json({
    channel: { id: channel.id, name: channel.name, kind: channel.kind },
    items: dtos.map((m, i) => ({
      ...m,
      authorName: rows[i]!.author_type === "system" ? "Sistema" : (names.get(`${rows[i]!.author_type}:${rows[i]!.author_id}`) ?? "Desconhecido"),
    })),
  });
});

toolRoutes.get("/channels", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "messages", "read");
  const rows = await all<ChannelRow & { is_member: number | null }>(
    t.db,
    `SELECT c.*, (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_type = 'agent' AND cm.member_id = ?) AS is_member
     FROM channels c WHERE c.workspace_id = ? AND c.humans_only = 0
       AND ((c.kind = 'channel' AND c.is_private = 0)
         OR (EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_type = 'agent' AND cm.member_id = ?)
           AND (c.id = ? OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_type = 'user' AND cm.member_id = ?))))
     ORDER BY c.kind, c.name`,
    t.agent.id,
    t.wsId,
    t.agent.id,
    t.job.channel_id ?? "",
    t.principalUserId,
  );
  const items = [];
  for (const r of rows) {
    let title = r.name ? `#${r.name}` : "DM";
    if (r.kind === "dm") {
      const other = await first<{ member_type: string; member_id: string }>(
        t.db,
        "SELECT member_type, member_id FROM channel_members WHERE channel_id = ? AND NOT (member_type = 'agent' AND member_id = ?) LIMIT 1",
        r.id,
        t.agent.id,
      );
      if (other?.member_type === "user") title = `DM com ${(await first<{ name: string }>(t.db, "SELECT name FROM users WHERE id = ?", other.member_id))?.name ?? "pessoa"}`;
      else if (other) title = `DM com @${(await first<{ handle: string }>(t.db, "SELECT handle FROM agents WHERE workspace_id = ? AND id = ?", t.wsId, other.member_id))?.handle ?? "agente"}`;
    }
    items.push({ id: r.id, kind: r.kind, name: r.name, title, section: r.section, topic: r.topic, isPrivate: r.is_private === 1, isMember: r.is_member === 1 });
  }
  return c.json({ items });
});

toolRoutes.get("/search", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "messages", "read");
  const q = c.req.query("q") ?? "";
  if (!q.trim()) throw badRequest("Informe o que buscar (q).");
  return c.json(
    await searchWorkspace(t.db, t.wsId, t.actor, q, {
      messages: true,
      tasks: hasPerm(t, "tasks", "read"),
      wiki: hasPerm(t, "wiki", "read"),
      files: hasPerm(t, "drive", "read"),
    }),
  );
});

// ---------- Memória ----------
toolRoutes.post("/memories", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "memory", "write");
  const body = await readBody(
    c,
    z.object({
      scope: z.enum(["agent", "team"]),
      content: z.string().trim().min(1).max(5000),
      source: z.enum(["agent", "extraction"]).default("agent"),
      /** Trecho literal de uma mensagem de pessoa que sustenta a memória. */
      quote: z.string().trim().max(600).optional(),
    }),
  );
  // Só fica confirmada a memória sustentada pelas palavras de uma pessoa nesta conversa. O resto entra como
  // "não confirmada": o agente a trata como provável, e ela aparece marcada para alguém confirmar ou apagar.
  const hit = findQuote(body.quote, await humanWords(t.db, t.wsId, t.job));
  const dto = await createMemory(t.db, t.wsId, t.actor, {
    scope: body.scope,
    agentId: t.agent.id,
    content: body.content,
    source: body.source,
    status: hit ? "confirmed" : "tentative",
    quote: hit ? body.quote! : null,
    sourceMessageId: hit?.messageId ?? null,
  });
  return c.json(dto, 201);
});

/**
 * Revisão automática de memória, mandada pelo runner ao fim do trabalho: o que guardar e o que já
 * não vale. O conteúdo vem de um modelo que leu a conversa, então os limites são aplicados aqui:
 * poucas mudanças por trabalho, textos curtos, e nunca apaga o que uma pessoa escreveu.
 */
toolRoutes.post("/memories/review", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "memory", "write");
  const body = await readBody(
    c,
    z.object({
      add: z
        .array(z.object({ scope: z.enum(["agent", "team"]), content: z.string().trim().min(1).max(MEMORY_REVIEW_MAX_CHARS), quote: z.string().trim().max(600).optional() }))
        .max(MEMORY_REVIEW_MAX_ADD)
        .default([]),
      // Runners antigos mandam só o id (sem citação): nada é apagado.
      remove: z
        .array(z.union([z.string().min(1).max(64), z.object({ id: z.string().min(1).max(64), quote: z.string().trim().max(600).optional() })]))
        .max(MEMORY_REVIEW_MAX_REMOVE)
        .default([]),
      usage: z.object({ inputTokens: z.number().int().min(0).max(5_000_000), outputTokens: z.number().int().min(0).max(1_000_000) }).optional(),
    }),
  );
  // Quem revisa é um modelo que leu a conversa. Uma mudança só vale com um trecho literal das palavras de
  // uma pessoa nesta conversa; o hub confere a citação no banco, não no que o runner mandou.
  const words = await humanWords(t.db, t.wsId, t.job);
  const removed: string[] = [];
  const seenRemove = new Set<string>();
  for (const item of body.remove) {
    const { id, quote } = typeof item === "string" ? { id: item, quote: undefined } : item;
    if (seenRemove.has(id) || !findQuote(quote, words)) continue;
    seenRemove.add(id);
    const row = await getMemory(t.db, t.wsId, id);
    if (!row || row.source === "user" || (row.scope === "agent" && row.agent_id !== t.agent.id)) continue;
    await deleteMemory(t.db, t.wsId, row.id);
    removed.push(row.content);
  }
  const existing = new Set(
    (await listMemories(t.db, t.wsId, { agentId: t.agent.id, includeTeamWithAgent: true, limit: 500 })).map((m) => m.content.trim().toLowerCase()),
  );
  const added: string[] = [];
  for (const m of body.add) {
    const key = m.content.trim().toLowerCase();
    const hit = findQuote(m.quote, words);
    if (existing.has(key) || !hit) continue;
    existing.add(key);
    await createMemory(t.db, t.wsId, t.actor, {
      scope: m.scope,
      agentId: t.agent.id,
      content: m.content,
      source: "extraction",
      status: "confirmed",
      quote: m.quote!,
      sourceMessageId: hit.messageId,
    });
    added.push(m.content);
  }
  // O custo da revisão entra na conta do trabalho (e, com isso, no orçamento do agente).
  if (body.usage && (body.usage.inputTokens || body.usage.outputTokens)) {
    await run(
      t.db,
      "UPDATE jobs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE workspace_id = ? AND id = ?",
      body.usage.inputTokens,
      body.usage.outputTokens,
      t.wsId,
      t.job.id,
    );
  }
  // Fica registrado no trabalho o que entrou e o que saiu, para dar para conferir (e refazer) depois.
  if (added.length || removed.length) {
    const cut = (x: string) => (x.length > 160 ? `${x.slice(0, 160)}…` : x);
    const summary = ["Memória revisada.", ...added.map((x) => `+ ${cut(x)}`), ...removed.map((x) => `− ${cut(x)}`)].join("\n").slice(0, 2000);
    const row = await first<{ id: number; created_at: number }>(
      t.db,
      "INSERT INTO job_events (job_id, kind, summary, created_at) VALUES (?, 'note', ?, ?) RETURNING id, created_at",
      t.job.id,
      summary,
      Date.now(),
    );
    const hub = c.get("hub");
    const event = toJobEventDTO({ id: row!.id, job_id: t.job.id, kind: "note", summary, created_at: row!.created_at });
    await hub.rt.publish({ type: "job.event", event }, await jobAudience(hub, t.job));
  }
  return c.json({ added: added.length, removed: removed.length });
});

/**
 * Procedimento aprendido: depois de um trabalho com vários passos, o runner manda o roteiro que o agente
 * seguiu, para reutilizar da próxima vez. É um texto escrito por um modelo a partir de um trabalho que pode
 * ter lido conteúdo externo, então: fica só com este agente, tem tamanho e quantidade limitados, aparece
 * marcado como "aprendido" (não é instrução de ninguém e não concede permissão) e o responsável pode
 * editar ou apagar. Um procedimento registra os passos, não a permissão: a checagem de ações continua valendo.
 */
toolRoutes.post("/skills/learned", async (c) => {
  const t = await tctx(c);
  const body = await readBody(
    c,
    z.object({
      name: z.string().trim().min(3).max(80),
      description: z.string().trim().min(1).max(300),
      body: z.string().trim().min(20).max(LEARNED_SKILL_MAX_CHARS),
    }),
  );
  if (t.agent.learn_skills === 0) throw forbidden("Este agente está com o aprendizado de procedimentos desligado.", "learning_disabled");
  if (t.job.origin !== "user" || t.job.mode === "prepare") throw forbidden("Só trabalhos pedidos por uma pessoa geram procedimento.", "learning_not_applicable");
  const now = Date.now();
  const existing = await first<{ id: string }>(
    t.db,
    "SELECT id FROM skills WHERE workspace_id = ? AND kind = 'learned' AND agent_id = ? AND name = ? COLLATE NOCASE",
    t.wsId,
    t.agent.id,
    body.name,
  );
  let id = existing?.id;
  if (id) {
    await run(t.db, "UPDATE skills SET description = ?, body = ?, source_job_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", body.description, body.body, t.job.id, now, t.wsId, id);
  } else {
    id = newId();
    await t.db.batch([
      t.db
        .prepare(
          `INSERT INTO skills (id, workspace_id, name, description, body, created_by, created_at, updated_at, kind, agent_id, source_job_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'learned', ?, ?)`,
        )
        .bind(id, t.wsId, body.name, body.description, body.body, t.agent.owner_user_id, now, now, t.agent.id, t.job.id),
      t.db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)").bind(t.agent.id, id),
    ]);
    // Limite por agente: os mais antigos (sem uso recente) saem.
    await run(
      t.db,
      `DELETE FROM skills WHERE workspace_id = ? AND kind = 'learned' AND agent_id = ? AND id NOT IN (
         SELECT id FROM skills WHERE workspace_id = ? AND kind = 'learned' AND agent_id = ? ORDER BY updated_at DESC LIMIT ?)`,
      t.wsId,
      t.agent.id,
      t.wsId,
      t.agent.id,
      LEARNED_SKILLS_PER_AGENT,
    );
  }
  const summary = `Procedimento ${existing ? "atualizado" : "aprendido"}: ${body.name}`;
  const ev = await first<{ id: number; created_at: number }>(t.db, "INSERT INTO job_events (job_id, kind, summary, created_at) VALUES (?, 'note', ?, ?) RETURNING id, created_at", t.job.id, summary, now);
  const hub = c.get("hub");
  await hub.rt.publish({ type: "job.event", event: toJobEventDTO({ id: ev!.id, job_id: t.job.id, kind: "note", summary, created_at: ev!.created_at }) }, await jobAudience(hub, t.job));
  await publishAgent(hub, t.agent.id);
  return c.json({ id, updated: !!existing }, existing ? 200 : 201);
});

toolRoutes.get("/memories", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "memory", "read");
  const scope = c.req.query("scope");
  if (scope && scope !== "agent" && scope !== "team") throw badRequest('scope deve ser "agent" ou "team".');
  const items = await listMemories(t.db, t.wsId, {
    scope: scope as "agent" | "team" | undefined,
    agentId: t.agent.id,
    includeTeamWithAgent: true,
    q: c.req.query("q") || undefined,
    limit: 100,
  });
  return c.json({
    items: items.map((m) => ({ id: m.id, scope: m.scope, content: m.content, source: m.source, updatedAt: m.updatedAt, ...(m.status === "tentative" ? { naoConfirmada: true } : {}) })),
  });
});

toolRoutes.delete("/memories/:id", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "memory", "write");
  const row = await getMemory(t.db, t.wsId, c.req.param("id"));
  if (!row || (row.scope === "agent" && row.agent_id !== t.agent.id)) throw notFound("Memória não encontrada.");
  await deleteMemory(t.db, t.wsId, row.id);
  return c.json({ ok: true, id: row.id });
});

// ---------- Tarefas ----------
toolRoutes.get("/tasks", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "tasks", "read");
  const status = c.req.query("status");
  const statuses = status ? status.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  if (statuses?.some((s) => !(TASK_STATUSES as readonly string[]).includes(s))) throw badRequest("status deve ser todo, doing, review ou done.");
  const assigneeRaw = c.req.query("assignee");
  let assignee: ActorRef | "none" | undefined;
  if (assigneeRaw === "none") assignee = "none";
  else if (assigneeRaw === "me") assignee = { type: "agent", id: t.agent.id };
  else if (assigneeRaw) {
    const agent = await first<{ id: string }>(t.db, "SELECT id FROM agents WHERE workspace_id = ? AND handle = ?", t.wsId, assigneeRaw.replace(/^@/, "").toLowerCase());
    assignee = agent ? { type: "agent", id: agent.id } : { type: "user", id: (await findUser(t, assigneeRaw)).id };
  }
  return c.json({ items: await listTasks(t.db, t.wsId, { statuses, assignee, q: c.req.query("q") || undefined, limit: 200 }) });
});

const toolTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  labels: z.array(z.string().max(40)).max(10).optional(),
  project: z.string().max(60).optional(),
  assigneeAgent: z.string().optional(),
  assigneeUser: z.string().optional(),
});

toolRoutes.post("/tasks", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "tasks", "write");
  const body = await readBody(c, toolTaskSchema);
  const assignee = await resolveAssignee(t, body.assigneeAgent, body.assigneeUser);
  const task = await createTask(c.get("hub"), t.actor, {
    title: body.title,
    description: body.description,
    status: body.status,
    priority: body.priority,
    labels: body.labels,
    project: body.project ?? null,
    assignee: assignee ?? null,
  });
  return c.json(task, 201);
});

function taskNumber(c: Context<ToolEnv>): number {
  const n = Number(c.req.param("numero"));
  if (!Number.isInteger(n) || n <= 0) throw badRequest("Número de tarefa inválido.");
  return n;
}

toolRoutes.patch("/tasks/:numero", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "tasks", "write");
  const task = await requireTaskByNumber(t.db, t.wsId, taskNumber(c));
  const body = await readBody(
    c,
    toolTaskSchema.partial().extend({
      title: z.string().trim().min(1).max(300).optional(),
      assigneeAgent: z.string().nullable().optional(),
      assigneeUser: z.string().nullable().optional(),
      subtasks: z.array(subtaskSchema).max(100).optional(),
      links: z.array(linkSchema).max(50).optional(),
    }),
  );
  let assignee: ActorRef | null | undefined;
  if (body.assigneeAgent === null || body.assigneeUser === null || body.assigneeAgent === "" || body.assigneeUser === "") assignee = null;
  else assignee = await resolveAssignee(t, body.assigneeAgent ?? undefined, body.assigneeUser ?? undefined);
  const dto = await updateTask(c.get("hub"), t.actor, task, {
    title: body.title,
    description: body.description,
    status: body.status,
    priority: body.priority,
    labels: body.labels,
    project: body.project,
    assignee,
    subtasks: body.subtasks,
    links: body.links,
  });
  return c.json(dto);
});

toolRoutes.post("/tasks/:numero/comments", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "tasks", "write");
  const task = await requireTaskByNumber(t.db, t.wsId, taskNumber(c));
  const { body } = await readBody(c, z.object({ body: z.string().trim().min(1).max(20_000) }));
  const comment = await addTaskComment(c.get("hub"), task.id, {
    author: t.actor.ref,
    body,
    onBehalfOfUserId: t.actor.onBehalfOfUserId,
    actor: t.actor,
  });
  return c.json(comment, 201);
});

// ---------- Wiki ----------
toolRoutes.get("/wiki", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "wiki", "read");
  const items = await listTree(t.db, t.wsId);
  return c.json({ items: items.map((p) => ({ id: p.id, title: p.title, parentId: p.parentId, isFolder: p.isFolder, version: p.version, updatedAt: p.updatedAt })) });
});

toolRoutes.get("/wiki/:ref", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "wiki", "read");
  const ref = c.req.param("ref");
  let page = await getPage(t.db, t.wsId, ref);
  if (!page || page.deleted_at != null) page = await findPageByTitle(t.db, t.wsId, ref);
  if (!page) throw notFound(`Página "${ref}" não encontrada na wiki.`);
  await recordRead(t.db, page.id, t.actor.ref);
  return c.json(toWikiPageDTO(page));
});

toolRoutes.put("/wiki", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "wiki", "write");
  const body = await readBody(
    c,
    z.object({
      id: z.string().optional(),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(200_000),
      parentTitle: z.string().trim().max(200).optional(),
      note: z.string().max(300).optional(),
    }),
  );
  const hub = c.get("hub");
  let parentId: string | null | undefined;
  if (body.parentTitle) {
    const parent = await findPageByTitle(t.db, t.wsId, body.parentTitle);
    parentId = parent ? parent.id : (await createPage(hub, t.actor, { title: body.parentTitle, isFolder: true })).id;
  }
  let page = body.id ? await getPage(t.db, t.wsId, body.id) : await findPageByTitle(t.db, t.wsId, body.title);
  if (body.id && (!page || page.deleted_at != null)) throw notFound("Página não encontrada.");
  if (page?.is_folder === 1 && !body.id) page = null;
  if (page) {
    // Achada pelo título (sem id): mantém o título original (a busca ignora maiúsculas).
    const dto = await updatePage(hub, t.actor, page, { title: body.id ? body.title : page.title, body: body.body, note: body.note ?? null, ...(parentId !== undefined ? { parentId } : {}) });
    return c.json({ ...dto, created: false });
  }
  const dto = await createPage(hub, t.actor, { title: body.title, body: body.body, parentId: parentId ?? null, note: body.note ?? null });
  return c.json({ ...dto, created: true }, 201);
});

// ---------- Drive ----------
toolRoutes.get("/files", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "drive", "read");
  return c.json({ items: await listFiles(t.db, t.wsId, t.actor, { q: c.req.query("q") || undefined, folder: c.req.query("folder") ?? null }) });
});

toolRoutes.get("/files/:id/content", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "drive", "read");
  const file = await requireVisibleFile(t.db, t.wsId, t.actor, c.req.param("id"));
  return fileContentResponse(c.env, file, false);
});

toolRoutes.post("/files", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "drive", "write");
  return c.json(await uploadFromRequest(c.get("hub"), t.actor, c.req.raw), 201);
});

// ---------- Time e agentes ----------
toolRoutes.get("/team", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "agents", "read");
  const people = await all<{ id: string; name: string; email: string; role: string; title: string | null; sector: string | null }>(
    t.db,
    `SELECT u.id, u.name, u.email, m.role, m.title, s.name AS sector FROM members m JOIN users u ON u.id = m.user_id
     LEFT JOIN sectors s ON s.id = m.sector_id WHERE m.workspace_id = ? ORDER BY u.name COLLATE NOCASE`,
    t.wsId,
  );
  const agents = await all<AgentRow & { sector: string | null }>(
    t.db,
    `SELECT a.*, s.name AS sector FROM agents a LEFT JOIN sectors s ON s.id = a.sector_id WHERE a.workspace_id = ? ORDER BY a.name COLLATE NOCASE`,
    t.wsId,
  );
  const callable = (a: AgentRow) =>
    a.id !== t.agent.id &&
    a.agents_can_consult === 1 &&
    !(a.is_assistant === 1 && a.owner_user_id !== t.agent.owner_user_id) &&
    (t.agent.callable_agents_mode === "all" || (t.agent.callable_agents_mode === "only" && JSON.parse(t.agent.callable_agents_json || "[]").includes(a.id)));
  return c.json({
    people: people.map((p) => ({ name: p.name, email: p.email, handle: userHandle(p), role: p.role, title: p.title, sector: p.sector })),
    agents: agents.map((a) => ({
      handle: a.handle,
      name: a.name,
      role: a.role,
      description: a.description,
      sector: a.sector,
      isAssistant: a.is_assistant === 1,
      status: a.status,
      isMe: a.id === t.agent.id,
      canConsult: callable(a),
    })),
  });
});

toolRoutes.post("/agents/:handle/ask", async (c) => {
  const t = await tctx(c);
  requirePerm(t, "agents", "write");
  const target = await requireAgentByHandle(t.db, t.wsId, c.req.param("handle"));
  const body = await readBody(
    c,
    z.object({
      prompt: z.string().trim().min(1).max(20_000),
      timeoutMs: z.number().int().min(1000).max(DEFAULT_WAIT_MS).optional(),
      queueTimeoutMs: z.number().int().min(100).max(DEFAULT_WAIT_MS).optional(),
    }),
  );
  const result = await consultAgent(c.get("hub"), {
    caller: t.agent,
    target,
    job: t.job,
    principalUserId: t.principalUserId,
    prompt: body.prompt,
    timeoutMs: body.timeoutMs ?? DEFAULT_WAIT_MS,
    queueTimeoutMs: body.queueTimeoutMs,
  });
  const note =
    result.status === "timeout"
      ? `@${target.handle} ainda não respondeu (o pedido continua na fila ou em execução). Siga sem a resposta e avise na sua resposta.`
      : result.status === "no_runner"
        ? `Nenhum computador pôde executar @${target.handle} agora (o runner pode estar ocupado com este próprio trabalho; com capacidade 1 a consulta não cabe). Siga sem a resposta e avise na sua resposta.`
      : result.status === "failed"
        ? `@${target.handle} parou com um erro: ${result.error ?? "erro desconhecido"}`
        : result.status === "cancelled"
          ? "A consulta foi cancelada."
          : undefined;
  return c.json({ text: result.text, status: result.status, jobId: result.jobId, agent: result.agent, ...(note ? { note } : {}) });
});

// ---------- Ações em conectores e no navegador (checagem de permissão) ----------
// Chamadas pelo intermediário de conectores do runner (`puxibot mcp-proxy`) antes e depois de cada ferramenta.
const actionCheckSchema = z.object({
  connectorId: z.string().min(1).max(64),
  tool: z.string().min(1).max(200),
  readOnly: z.boolean(),
  args: z.record(z.string(), z.unknown()).optional(),
});

toolRoutes.post("/actions", async (c) => {
  const t = await tctx(c);
  const body = await readBody(c, actionCheckSchema);
  const isBrowser = body.connectorId === BROWSER_TOOL;
  const level = t.perms[isBrowser ? BROWSER_TOOL : `connector:${body.connectorId}`] ?? "none";
  const name = await connectorLabel(t.db, t.wsId, body.connectorId);
  if (!name || level === "none") throw forbidden(`${t.agent.name} não tem acesso a este conector.`, "tool_permission_denied");
  // "Somente leitura": só passa o que o próprio conector marca como leitura (o navegador não tem esse nível).
  if (!body.readOnly && level !== "write") {
    throw forbidden(`${t.agent.name} tem acesso somente leitura a ${name}; esta ferramenta pode alterar dados.`, "tool_permission_denied");
  }
  return c.json(await checkAction(c.get("hub"), { ...body, agent: t.agent, job: t.job, connectorName: name }));
});

async function ownAction(c: Context<ToolEnv>) {
  const claims = c.get("job");
  const row = await getAction(c.env.DB, claims.workspaceId, c.req.param("id")!);
  if (!row || row.job_id !== claims.jobId) throw notFound("Ação não encontrada.");
  return row;
}

toolRoutes.get("/actions/:id", async (c) => c.json(actionState(await ownAction(c))));

toolRoutes.post("/actions/:id/result", async (c) => {
  const row = await ownAction(c);
  const body = await readBody(c, z.object({ ok: z.boolean(), error: z.string().max(2000).optional() }));
  if (row.decision !== "allowed") throw badRequest("Esta ação não foi liberada.");
  await finishAction(c.env.DB, c.get("job").workspaceId, row, body.ok, body.error);
  return c.json({ ok: true });
});

// ---------- Aprovações (sempre permitido) ----------
toolRoutes.post("/approvals", async (c) => {
  const t = await tctx(c);
  const body = await readBody(c, z.object({ title: z.string().trim().min(1).max(200), details: z.string().max(5000).optional() }));
  const row: ApprovalRow = {
    id: newId(),
    workspace_id: t.wsId,
    agent_id: t.agent.id,
    job_id: t.job.id,
    kind: "action",
    title: body.title,
    details: body.details ?? null,
    approver_user_id: t.agent.owner_user_id,
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: Date.now(),
  };
  await run(
    t.db,
    `INSERT INTO approvals (id, workspace_id, agent_id, job_id, kind, title, details, approver_user_id, status, created_at)
     VALUES (?, ?, ?, ?, 'action', ?, ?, ?, 'pending', ?)`,
    row.id,
    row.workspace_id,
    row.agent_id,
    row.job_id,
    row.title,
    row.details,
    row.approver_user_id,
    row.created_at,
  );
  const hub = c.get("hub");
  const dto = await publishApproval(hub, row);
  // Título genérico (vai também para push/Telegram); o pedido em si fica no corpo e na tela de aprovações.
  await notify(hub, {
    userId: row.approver_user_id,
    kind: "approval",
    title: `${t.agent.name} pediu sua aprovação`,
    body: row.title,
    link: links.approvals(t.wsId),
  });
  return c.json(dto, 201);
});

/**
 * Pedido de segredo: a pessoa digita numa caixa da interface e o valor vai direto para o cofre ou para o
 * conector. O agente acompanha o estado por GET /approvals/:id e nunca recebe o valor.
 */
toolRoutes.post("/secret-requests", async (c) => {
  const t = await tctx(c);
  const body = await readBody(c, secretRequestSchema);
  return c.json(await createSecretRequest(c.get("hub"), body, { agent: t.agent, job: t.job, principalUserId: t.principalUserId, perms: t.perms }), 201);
});

toolRoutes.get("/approvals/:id", async (c) => {
  const t = await tctx(c);
  const row = await first<ApprovalRow>(t.db, "SELECT * FROM approvals WHERE workspace_id = ? AND id = ? AND agent_id = ?", t.wsId, c.req.param("id"), t.agent.id);
  if (!row) throw notFound("Aprovação não encontrada.");
  return c.json(toApprovalDTO(row));
});

// ---------- Só assistente pessoal, agindo como o dono ----------
function requireAssistant(t: ToolCtx, what: string): string {
  if (t.job.mode === "prepare") throw forbidden(`Preparação automática não pode ${what}.`, "prepare_read_only");
  if (t.agent.is_assistant !== 1) throw forbidden(`Só o assistente pessoal pode ${what}.`, "assistant_only");
  if (t.job.requested_by_user_id && t.job.requested_by_user_id !== t.agent.owner_user_id) {
    throw forbidden(`O assistente só pode ${what} a pedido da pessoa dona dele.`, "assistant_only");
  }
  return t.agent.owner_user_id;
}

toolRoutes.post("/agents", async (c) => {
  const t = await tctx(c);
  const ownerId = requireAssistant(t, "criar agentes");
  const body = await readBody(
    c,
    z.object({
      handle: handleSchema,
      name: z.string().trim().min(1).max(60),
      role: z.string().max(60).optional(),
      description: z.string().max(500).optional(),
      instructions: z.string().max(50_000).optional(),
    }),
  );
  const agent = await createAgent(c.get("hub"), {
    handle: body.handle,
    name: body.name,
    role: body.role ?? null,
    description: body.description ?? null,
    instructions: body.instructions ?? "",
    ownerUserId: ownerId,
  });
  return c.json(agent, 201);
});

toolRoutes.post("/routines", async (c) => {
  const t = await tctx(c);
  const ownerId = requireAssistant(t, "criar rotinas");
  const body = await readBody(
    c,
    z.object({
      agent: z.string().optional(),
      name: z.string().trim().min(1).max(100),
      prompt: z.string().min(1).max(20_000),
      cron: z.string().min(1).max(120),
      timezone: z.string().max(64).optional(),
      channel: z.string().optional(),
    }),
  );
  const target = body.agent ? await requireAgentByHandle(t.db, t.wsId, body.agent) : t.agent;
  const owner = await first<{ role: string }>(t.db, "SELECT role FROM members WHERE workspace_id = ? AND user_id = ?", t.wsId, ownerId);
  const ownerIsAdmin = owner?.role === "owner" || owner?.role === "admin";
  if (target.owner_user_id !== ownerId && !ownerIsAdmin) {
    throw forbidden(`Sua pessoa não é responsável por @${target.handle}; só o responsável ou um admin cria rotinas para ele.`);
  }
  if (target.is_assistant === 1 && target.owner_user_id !== ownerId) throw forbidden("Não é possível criar rotinas para o assistente de outra pessoa.");
  const timezone = body.timezone?.trim() || DEFAULT_TIMEZONE;
  assertValidSchedule(body.cron, timezone);
  let channelId: string | null = null;
  if (body.channel) {
    const ch = await findChannelByRef(t.db, t.wsId, body.channel);
    const ownerSees =
      ch &&
      ch.humans_only === 0 &&
      ((ch.kind === "channel" && ch.is_private === 0) ||
        (await first(t.db, "SELECT 1 AS one FROM channel_members WHERE channel_id = ? AND member_type = 'user' AND member_id = ?", ch.id, ownerId)));
    if (!ch || !ownerSees) throw notFound(`Canal "${body.channel}" não encontrado.`);
    await assertRoutineChannel(t.db, ch, target);
    channelId = ch.id;
  } else if (t.job.channel_id && target.id === t.agent.id) {
    channelId = t.job.channel_id;
  } else {
    channelId = (await findOrCreateDm(t.db, t.wsId, { type: "user", id: ownerId }, { type: "agent", id: target.id }, ownerId)).channel.id;
  }
  const row = await insertRoutine(t.db, t.wsId, {
    agentId: target.id,
    name: body.name,
    prompt: body.prompt,
    cron: body.cron,
    timezone,
    channelId,
    enabled: true,
    kind: "custom",
    createdBy: ownerId,
  });
  await c.get("hub").rt.pump();
  return c.json(toRoutineDTO(row), 201);
});

// ---------- Progresso (sempre permitido) ----------
toolRoutes.post("/progress", async (c) => {
  const t = await tctx(c);
  const { summary } = await readBody(c, z.object({ summary: z.string().trim().min(1).max(500) }));
  const row = await first<{ id: number; created_at: number }>(
    t.db,
    "INSERT INTO job_events (job_id, kind, summary, created_at) VALUES (?, 'note', ?, ?) RETURNING id, created_at",
    t.job.id,
    summary,
    Date.now(),
  );
  const event = toJobEventDTO({ id: row!.id, job_id: t.job.id, kind: "note", summary, created_at: row!.created_at });
  const hub = c.get("hub");
  await hub.rt.publish({ type: "job.event", event }, await jobAudience(hub, t.job));
  return c.json({ ok: true, event }, 201);
});
