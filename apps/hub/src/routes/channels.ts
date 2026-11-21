import { Hono, type Context } from "hono";
import { z } from "zod";
import { sendMessageSchema, userHandle, extractMentions, type ActorRef, type AttachmentDTO } from "@puxibot/shared";
import { all, bool, first, newId, placeholders, run, stmt, type SqlValue } from "../lib/db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { intParam, parseWith, readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { canTalkTo, requireAgentRow } from "../domain/agents";
import {
  addChannelMemberStmt,
  assertActorInWorkspace,
  canSeeChannel,
  channelAudience,
  channelDTO,
  findOrCreateDm,
  isChannelMember,
  listVisibleChannels,
  publishChannel,
  requireVisibleChannel,
} from "../domain/channels";
import { insertMessage, messageDTO, messagesToDTO, publishMessageUpdated, requireMessageRow } from "../domain/messages";
import { links, notify } from "../domain/notify";
import { routeMessage } from "../domain/routing";
import type { AgentRow, ChannelRow, FileRow, MessageRow } from "../domain/rows";
import { userActor } from "../domain/actor";
import { fileVisibilitySql } from "../domain/files";
import { getWorkspaceRow } from "../domain/workspaces";

/** Canais, DMs, mensagens, reações e leitura. */
export const channelRoutes = new Hono<WsEnv>();

const actorSchema = z.object({ type: z.enum(["user", "agent"]), id: z.string().min(1) });

function normalizeChannelName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw badRequest("Nome de canal inválido.");
  return slug;
}

async function assertNameFree(db: D1Database, wsId: string, name: string, exceptId?: string) {
  const row = await first<{ id: string }>(
    db,
    "SELECT id FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name = ?",
    wsId,
    name,
  );
  if (row && row.id !== exceptId) throw conflict(`Já existe um canal #${name}.`, "channel_name_taken");
}

function canManage(c: Context<WsEnv>, ch: ChannelRow): boolean {
  return ch.created_by === c.get("userId") || isAdmin(c);
}

channelRoutes.get("/channels", async (c) => {
  return c.json({ items: await listVisibleChannels(c.env.DB, c.get("wsId"), c.get("userId")) });
});

const createChannelSchema = z.object({
  name: z.string().min(1).max(80),
  section: z.string().max(60).nullable().optional(),
  topic: z.string().max(300).nullable().optional(),
  humansOnly: z.boolean().default(false),
  isPrivate: z.boolean().default(false),
  members: z.array(actorSchema).max(200).default([]),
});

channelRoutes.post("/channels", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const body = await readBody(c, createChannelSchema);
  const name = normalizeChannelName(body.name);
  await assertNameFree(db, wsId, name);
  const members: ActorRef[] = [{ type: "user", id: userId }];
  for (const m of body.members) {
    if (m.type === "agent" && body.humansOnly) throw badRequest("Agentes não entram em canal só de humanos.", "humans_only");
    await assertActorInWorkspace(db, wsId, m);
    if (!members.some((x) => x.type === m.type && x.id === m.id)) members.push(m);
  }
  const id = newId();
  const now = Date.now();
  await db.batch([
    stmt(
      db,
      `INSERT INTO channels (id, workspace_id, kind, name, section, topic, humans_only, is_private, dm_key, created_by, created_at, last_message_at)
       VALUES (?, ?, 'channel', ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      id,
      wsId,
      name,
      body.section ?? null,
      body.topic ?? null,
      body.humansOnly ? 1 : 0,
      body.isPrivate ? 1 : 0,
      userId,
      now,
    ),
    ...members.map((m) => addChannelMemberStmt(db, id, m, now)),
  ]);
  const ch = (await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND id = ?", wsId, id))!;
  await publishChannel(c.get("hub"), ch);
  return c.json(await channelDTO(db, wsId, ch, userId), 201);
});

const patchChannelSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  section: z.string().max(60).nullable().optional(),
  topic: z.string().max(300).nullable().optional(),
  humansOnly: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
});

channelRoutes.patch("/channels/:id", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const ch = await requireVisibleChannel(db, wsId, c.req.param("id"), c.get("userId"));
  if (!canManage(c, ch)) throw forbidden("Só quem criou o canal ou um admin pode mudá-lo.");
  const body = await readBody(c, patchChannelSchema);
  if (ch.kind === "dm" && (body.name !== undefined || body.isPrivate !== undefined || body.humansOnly !== undefined)) {
    throw badRequest("DMs não têm nome, privacidade nem modo só de humanos.");
  }
  const before = await channelAudience(db, ch);
  const next: ChannelRow = { ...ch };
  if (body.name !== undefined) {
    next.name = normalizeChannelName(body.name);
    await assertNameFree(db, wsId, next.name, ch.id);
  }
  if (body.section !== undefined) next.section = body.section;
  if (body.topic !== undefined) next.topic = body.topic;
  if (body.humansOnly !== undefined) next.humans_only = body.humansOnly ? 1 : 0;
  if (body.isPrivate !== undefined) next.is_private = body.isPrivate ? 1 : 0;
  const statements = [
    stmt(
      db,
      "UPDATE channels SET name = ?, section = ?, topic = ?, humans_only = ?, is_private = ? WHERE workspace_id = ? AND id = ?",
      next.name,
      next.section,
      next.topic,
      next.humans_only,
      next.is_private,
      wsId,
      ch.id,
    ),
  ];
  // Canal virou só de humanos: agentes saem.
  if (next.humans_only === 1 && ch.humans_only === 0) {
    statements.push(stmt(db, "DELETE FROM channel_members WHERE channel_id = ? AND member_type = 'agent'", ch.id));
  }
  await db.batch(statements);
  const dto = await publishChannel(c.get("hub"), next);
  // Quem deixou de enxergar (canal virou privado) recebe channel.deleted.
  const after = await channelAudience(db, next);
  if (before === null && after !== null) {
    const removed = (await all<{ user_id: string }>(db, "SELECT user_id FROM members WHERE workspace_id = ?", wsId))
      .map((m) => m.user_id)
      .filter((u) => !after.includes(u));
    if (removed.length) await c.get("hub").rt.publish({ type: "channel.deleted", channelId: ch.id }, removed);
  }
  return c.json({ ...dto, unread: (await channelDTO(db, wsId, next, c.get("userId"))).unread });
});

channelRoutes.delete("/channels/:id", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const ch = await requireVisibleChannel(db, wsId, c.req.param("id"), c.get("userId"));
  if (!canManage(c, ch)) throw forbidden("Só quem criou o canal ou um admin pode apagá-lo.");
  const audience = await channelAudience(db, ch);
  await run(db, "DELETE FROM channels WHERE workspace_id = ? AND id = ?", wsId, ch.id);
  await c.get("hub").rt.publish({ type: "channel.deleted", channelId: ch.id }, audience);
  return c.body(null, 204);
});

const memberBodySchema = z.object({ member: actorSchema });

channelRoutes.post("/channels/:id/members", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const ch = await requireVisibleChannel(db, wsId, c.req.param("id"), userId);
  if (ch.kind === "dm") throw badRequest("Não é possível adicionar membros a uma DM.");
  const { member } = await readBody(c, memberBodySchema);
  if (member.type === "agent" && bool(ch.humans_only)) throw badRequest("Agentes não entram em canal só de humanos.", "humans_only");
  await assertActorInWorkspace(db, wsId, member);
  // Canal aberto: qualquer membro do workspace entra sozinho. Adicionar outra pessoa ou agente: criador do canal ou admin.
  const selfJoin = member.type === "user" && member.id === userId;
  if (!selfJoin && !canManage(c, ch)) {
    throw forbidden("Só quem criou o canal ou um admin adiciona pessoas e agentes.");
  }
  const before = await channelAudience(db, ch);
  await addChannelMemberStmt(db, ch.id, member).run();
  const dto = await publishChannel(c.get("hub"), ch);
  // Em canal privado, quem entrou não estava na audiência anterior.
  if (before !== null && member.type === "user" && !before.includes(member.id)) {
    await c.get("hub").rt.publish({ type: "channel.upserted", channel: dto }, [member.id]);
  }
  return c.json(dto);
});

channelRoutes.delete("/channels/:id/members", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const ch = await requireVisibleChannel(db, wsId, c.req.param("id"), userId);
  if (ch.kind === "dm") throw badRequest("Não é possível remover membros de uma DM.");
  // Aceita o membro no corpo `{ member }` ou na query `?type=&id=` (DELETE sem corpo).
  const qType = c.req.query("type");
  const qId = c.req.query("id");
  const { member } =
    qType && qId ? { member: parseWith(actorSchema, { type: qType, id: qId }) } : await readBody(c, memberBodySchema);
  const self = member.type === "user" && member.id === userId;
  if (!self && !canManage(c, ch)) throw forbidden("Só quem criou o canal ou um admin pode remover membros.");
  await run(
    db,
    "DELETE FROM channel_members WHERE channel_id = ? AND member_type = ? AND member_id = ?",
    ch.id,
    member.type,
    member.id,
  );
  const dto = await publishChannel(c.get("hub"), ch);
  if (!bool(ch.is_private) || member.type !== "user") return c.json(dto);
  await c.get("hub").rt.publish({ type: "channel.deleted", channelId: ch.id }, [member.id]);
  return c.json(dto);
});

const dmSchema = z.object({ with: actorSchema });

channelRoutes.post("/dms", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const body = await readBody(c, dmSchema);
  await assertActorInWorkspace(db, wsId, body.with);
  if (body.with.type === "agent") {
    const agent = await requireAgentRow(db, wsId, body.with.id);
    if (!(await canTalkTo(db, agent, userId))) {
      throw forbidden(`Você não tem permissão para falar com ${agent.name}.`, "agent_access_denied");
    }
  }
  const { channel, created } = await findOrCreateDm(db, wsId, { type: "user", id: userId }, body.with, userId);
  if (created) await publishChannel(c.get("hub"), channel);
  return c.json(await channelDTO(db, wsId, channel, userId), created ? 201 : 200);
});

// ---------- Mensagens ----------
channelRoutes.get("/channels/:id/messages", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const ch = await requireVisibleChannel(db, wsId, c.req.param("id"), c.get("userId"));
  const limit = intParam(c.req.query("limit"), 50, 1, 100);
  const cursor = parseBeforeCursor(c.req.query("before"));
  const threadRootId = c.req.query("threadRootId");
  const pinned = c.req.query("pinned") === "1" || c.req.query("pinned") === "true";
  let sql = "SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ?";
  const params: SqlValue[] = [wsId, ch.id];
  if (cursor) {
    // Cursor composto (created_at, id): estável quando várias mensagens têm o mesmo created_at.
    sql += cursor.id ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : " AND created_at < ?";
    params.push(cursor.createdAt);
    if (cursor.id) params.push(cursor.createdAt, cursor.id);
  }
  let root: MessageRow | null = null;
  if (pinned) sql += " AND pinned = 1 AND deleted_at IS NULL";
  else if (threadRootId) {
    root = await first<MessageRow>(db, "SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ? AND id = ?", wsId, ch.id, threadRootId);
    if (!root) throw notFound("Mensagem raiz da thread não encontrada.");
    sql += " AND thread_root_id = ?";
    params.push(threadRootId);
  } else sql += " AND thread_root_id IS NULL";
  sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
  params.push(limit + 1);
  const rows = await all<MessageRow>(db, sql, ...params);
  const hasMore = rows.length > limit;
  if (hasMore) rows.length = limit;
  rows.reverse();
  const oldest = rows[0];
  const nextBefore = hasMore && oldest ? `${oldest.created_at}:${oldest.id}` : null;
  // Na página mais antiga da thread, a raiz vem primeiro em `items`; ela também vai sempre em `root`.
  const withRoot = root && !hasMore ? [root, ...rows] : rows;
  const items = await messagesToDTO(db, wsId, withRoot);
  const rootDto = root ? (items[0]?.id === root.id ? items[0]! : await messageDTO(db, wsId, root)) : undefined;
  return c.json({ items, nextBefore, ...(root ? { root: rootDto } : {}) });
});

/** `before`: "<createdAt>" (compatível com a primeira versão) ou "<createdAt>:<id>". */
function parseBeforeCursor(raw: string | undefined): { createdAt: number; id: string | null } | null {
  if (!raw) return null;
  const m = /^(\d{1,16})(?::(.+))?$/.exec(raw.trim());
  if (!m) throw badRequest('Cursor "before" inválido; use <createdAt> ou <createdAt>:<id>.');
  return { createdAt: Number(m[1]), id: m[2] ?? null };
}

channelRoutes.get("/messages/:id", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const row = await requireMessageRow(db, wsId, c.req.param("id"));
  await requireVisibleChannel(db, wsId, row.channel_id, c.get("userId"));
  return c.json(await messageDTO(db, wsId, row));
});

/** Resolve @handles: primeiro agentes, depois pessoas (`userHandle`). */
async function resolveMentions(db: D1Database, wsId: string, body: string) {
  const handles = extractMentions(body);
  if (handles.length === 0) return { agents: [] as AgentRow[], mentions: [] as ActorRef[] };
  const agents = await all<AgentRow>(
    db,
    `SELECT * FROM agents WHERE workspace_id = ? AND handle IN (${placeholders(handles.length)})`,
    wsId,
    ...handles,
  );
  const mentions: ActorRef[] = agents.map((a) => ({ type: "agent", id: a.id }));
  const rest = handles.filter((h) => !agents.some((a) => a.handle === h));
  if (rest.length) {
    const users = await all<{ id: string; email: string }>(
      db,
      "SELECT u.id, u.email FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?",
      wsId,
    );
    for (const u of users) if (rest.includes(userHandle(u))) mentions.push({ type: "user", id: u.id });
  }
  return { agents, mentions };
}

channelRoutes.post("/channels/:id/messages", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const hub = c.get("hub");
  const ch = await requireVisibleChannel(db, wsId, c.req.param("id"), userId);
  const body = await readBody(c, sendMessageSchema);
  if (!body.body.trim() && !body.attachmentIds?.length) throw badRequest("A mensagem está vazia.");
  if (body.threadRootId) {
    const root = await first<MessageRow>(
      db,
      "SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ? AND id = ?",
      wsId,
      ch.id,
      body.threadRootId,
    );
    if (!root) throw notFound("Mensagem raiz da thread não encontrada.");
    if (root.thread_root_id) throw badRequest("Responda na mensagem raiz da thread.");
  }
  if (body.quote) {
    // A citação aponta para uma mensagem do mesmo canal (não dá para "citar" o que está num canal privado).
    const quoted = await first(db, "SELECT 1 AS one FROM messages WHERE workspace_id = ? AND channel_id = ? AND id = ?", wsId, ch.id, body.quote.messageId);
    if (!quoted) throw notFound("Mensagem citada não encontrada neste canal.");
  }
  let attachments: AttachmentDTO[] = [];
  if (body.attachmentIds?.length) {
    attachments = await resolveAttachments(c, ch, [...new Set(body.attachmentIds)]);
  }
  // Escrever em canal aberto do qual não é membro: entra no canal.
  if (!(await isChannelMember(db, ch.id, { type: "user", id: userId }))) {
    await addChannelMemberStmt(db, ch.id, { type: "user", id: userId }).run();
  }
  const { agents, mentions } = await resolveMentions(db, wsId, body.body);
  const message = await insertMessage(hub, {
    channel: ch,
    author: { type: "user", id: userId },
    body: body.body,
    threadRootId: body.threadRootId ?? null,
    quote: body.quote ?? null,
    attachments,
    mentions,
  });
  await notifyHumans(c, ch, message.id, mentions);
  const workspace = await getWorkspaceRow(db, wsId);
  await routeMessage(hub, {
    channel: ch,
    message,
    userId,
    mentionedAgents: agents,
    routerEnabled: bool(workspace?.router_enabled),
  });
  return c.json(message, 201);
});

/**
 * Anexos: o arquivo precisa ser visível a quem envia e pertencer a este canal (ou não ter canal: drive, ou
 * upload pendente da própria pessoa, que passa a ser deste canal). Um arquivo de canal privado não "vaza"
 * como anexo em outro canal.
 */
async function resolveAttachments(c: Context<WsEnv>, ch: ChannelRow, ids: string[]): Promise<AttachmentDTO[]> {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const me = userActor(c.get("userId"), isAdmin(c));
  const vis = fileVisibilitySql(me);
  const files = await all<FileRow>(
    db,
    `SELECT f.* FROM files f WHERE f.workspace_id = ? AND f.id IN (${placeholders(ids.length)}) AND ${vis.sql}`,
    wsId,
    ...ids,
    ...vis.params,
  );
  if (files.length !== ids.length || files.some((f) => f.channel_id != null && f.channel_id !== ch.id)) {
    throw notFound("Anexo não encontrado.");
  }
  const pending = files.filter((f) => f.channel_id == null && f.in_drive === 0).map((f) => f.id);
  if (pending.length) {
    await run(
      db,
      `UPDATE files SET channel_id = ? WHERE workspace_id = ? AND channel_id IS NULL AND in_drive = 0 AND id IN (${placeholders(pending.length)})`,
      ch.id,
      wsId,
      ...pending,
    );
  }
  return files.map((f) => ({ fileId: f.id, name: f.name, mime: f.mime, size: f.size }));
}

/** Notificações para pessoas: menção (`mention`) e DM entre pessoas (`dm`). Só para quem enxerga o canal. */
async function notifyHumans(c: Context<WsEnv>, ch: ChannelRow, _messageId: string, mentions: ActorRef[]) {
  const db = c.env.DB;
  const userId = c.get("userId");
  const hub = c.get("hub");
  const me = await first<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", userId);
  const name = me?.name ?? "Alguém";
  const notified = new Set<string>([userId]);
  if (ch.kind === "dm") {
    const others = await all<{ member_id: string }>(
      db,
      "SELECT member_id FROM channel_members WHERE channel_id = ? AND member_type = 'user' AND member_id <> ?",
      ch.id,
      userId,
    );
    for (const o of others) {
      notified.add(o.member_id);
      await notify(hub, { userId: o.member_id, kind: "dm", title: `${name} mandou uma mensagem`, link: links.channel(c.get("wsId"), ch.id) });
    }
  }
  for (const m of mentions) {
    if (m.type !== "user" || notified.has(m.id)) continue;
    notified.add(m.id);
    // Mencionar quem não está no canal privado/DM não avisa (o aviso revelaria o canal).
    if (!(await canSeeChannel(db, ch, m.id))) continue;
    await notify(hub, {
      userId: m.id,
      kind: "mention",
      title: ch.kind === "dm" ? `${name} mencionou você` : `${name} mencionou você em #${ch.name ?? "canal"}`,
      link: links.channel(c.get("wsId"), ch.id),
    });
  }
}

const patchMessageSchema = z.object({
  body: z.string().max(20_000).optional(),
  pinned: z.boolean().optional(),
});

channelRoutes.patch("/messages/:id", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const row = await requireMessageRow(db, wsId, c.req.param("id"));
  const ch = await requireVisibleChannel(db, wsId, row.channel_id, userId);
  const body = await readBody(c, patchMessageSchema);
  if (row.deleted_at) throw badRequest("Mensagem apagada.");
  const next = { ...row };
  if (body.body !== undefined) {
    if (row.author_type !== "user" || row.author_id !== userId) throw forbidden("Só o autor edita a mensagem.");
    if (!body.body.trim()) throw badRequest("A mensagem está vazia.");
    next.body = body.body;
    next.edited_at = Date.now();
  }
  if (body.pinned !== undefined) {
    if (!(await isChannelMember(db, ch.id, { type: "user", id: userId })) && !isAdmin(c)) {
      throw forbidden("Só membros do canal fixam mensagens.");
    }
    next.pinned = body.pinned ? 1 : 0;
  }
  await run(
    db,
    "UPDATE messages SET body = ?, edited_at = ?, pinned = ? WHERE workspace_id = ? AND id = ?",
    next.body,
    next.edited_at,
    next.pinned,
    wsId,
    row.id,
  );
  return c.json(await publishMessageUpdated(c.get("hub"), next));
});

channelRoutes.delete("/messages/:id", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const row = await requireMessageRow(db, wsId, c.req.param("id"));
  const ch = await requireVisibleChannel(db, wsId, row.channel_id, userId);
  const isAuthor = row.author_type === "user" && row.author_id === userId;
  if (!isAuthor && !isAdmin(c)) throw forbidden("Só o autor ou um admin apaga a mensagem.");
  await run(db, "UPDATE messages SET deleted_at = ? WHERE workspace_id = ? AND id = ?", Date.now(), wsId, row.id);
  await c.get("hub").rt.publish({ type: "message.deleted", channelId: ch.id, messageId: row.id }, await channelAudience(db, ch));
  return c.body(null, 204);
});

const reactionSchema = z.object({ emoji: z.string().min(1).max(32) });

async function react(c: Context<WsEnv>, add: boolean) {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const row = await requireMessageRow(db, wsId, c.req.param("id")!);
  await requireVisibleChannel(db, wsId, row.channel_id, userId);
  // DELETE também aceita `?emoji=` (sem corpo).
  const qEmoji = c.req.query("emoji");
  const { emoji } = qEmoji ? parseWith(reactionSchema, { emoji: qEmoji }) : await readBody(c, reactionSchema);
  if (add) {
    await run(
      db,
      "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
      row.id,
      userId,
      emoji,
      Date.now(),
    );
  } else {
    await run(db, "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", row.id, userId, emoji);
  }
  return c.json(await publishMessageUpdated(c.get("hub"), row));
}

channelRoutes.post("/messages/:id/reactions", (c) => react(c, true));
channelRoutes.delete("/messages/:id/reactions", (c) => react(c, false));

channelRoutes.post("/channels/:id/read", async (c) => {
  const db = c.env.DB;
  const ch = await requireVisibleChannel(db, c.get("wsId"), c.req.param("id"), c.get("userId"));
  await run(
    db,
    "UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND member_type = 'user' AND member_id = ?",
    Date.now(),
    ch.id,
    c.get("userId"),
  );
  return c.body(null, 204);
});
