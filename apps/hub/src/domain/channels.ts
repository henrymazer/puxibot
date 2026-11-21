import { dmKey, type ActorRef, type ChannelDTO } from "@puxibot/shared";
import { all, bool, first, newId, placeholders, run, stmt } from "../lib/db";
import { forbidden, notFound } from "../lib/errors";
import type { HubCtx } from "./context";
import type { ChannelMemberRow, ChannelRow } from "./rows";

export async function getChannel(db: D1Database, wsId: string, channelId: string): Promise<ChannelRow | null> {
  return first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND id = ?", wsId, channelId);
}

export async function channelMembers(db: D1Database, channelId: string): Promise<ChannelMemberRow[]> {
  return all<ChannelMemberRow>(db, "SELECT * FROM channel_members WHERE channel_id = ?", channelId);
}

export async function isChannelMember(db: D1Database, channelId: string, actor: ActorRef): Promise<boolean> {
  const row = await first<{ one: number }>(
    db,
    "SELECT 1 AS one FROM channel_members WHERE channel_id = ? AND member_type = ? AND member_id = ?",
    channelId,
    actor.type,
    actor.id,
  );
  return row != null;
}

/** Canal comum não privado: visível a todo o workspace. DM e privado: só membros. */
export function isOpenChannel(ch: Pick<ChannelRow, "kind" | "is_private">): boolean {
  return ch.kind === "channel" && !bool(ch.is_private);
}

export async function canSeeChannel(db: D1Database, ch: ChannelRow, userId: string): Promise<boolean> {
  if (isOpenChannel(ch)) return true;
  return isChannelMember(db, ch.id, { type: "user", id: userId });
}

/** Carrega o canal e garante que a pessoa o enxerga (404 se não; não revela existência). */
export async function requireVisibleChannel(db: D1Database, wsId: string, channelId: string, userId: string) {
  const ch = await getChannel(db, wsId, channelId);
  if (!ch || !(await canSeeChannel(db, ch, userId))) throw notFound("Canal não encontrado.");
  return ch;
}

/** Quem recebe eventos do canal: `null` = todo o workspace; senão os ids das pessoas membros. */
export async function channelAudience(db: D1Database, ch: Pick<ChannelRow, "id" | "kind" | "is_private">) {
  if (isOpenChannel(ch)) return null;
  const rows = await all<{ member_id: string }>(
    db,
    "SELECT member_id FROM channel_members WHERE channel_id = ? AND member_type = 'user'",
    ch.id,
  );
  return rows.map((r) => r.member_id);
}

export async function channelAudienceById(db: D1Database, wsId: string, channelId: string) {
  const ch = await getChannel(db, wsId, channelId);
  return ch ? channelAudience(db, ch) : [];
}

/** Canais visíveis a uma pessoa, com membros e não lidas. */
export async function listVisibleChannels(db: D1Database, wsId: string, userId: string): Promise<ChannelDTO[]> {
  const rows = await all<ChannelRow & { my_last_read: number | null }>(
    db,
    `SELECT c.*, me.last_read_at AS my_last_read FROM channels c
     LEFT JOIN channel_members me ON me.channel_id = c.id AND me.member_type = 'user' AND me.member_id = ?
     WHERE c.workspace_id = ? AND ((c.kind = 'channel' AND c.is_private = 0) OR me.member_id IS NOT NULL)
     ORDER BY c.kind, c.name`,
    userId,
    wsId,
  );
  return channelsToDTO(db, wsId, rows, userId);
}

export async function channelsToDTO(
  db: D1Database,
  wsId: string,
  rows: (ChannelRow & { my_last_read?: number | null })[],
  viewerUserId: string | null,
): Promise<ChannelDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const members = await all<ChannelMemberRow>(
    db,
    `SELECT cm.* FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
     WHERE c.workspace_id = ? AND cm.channel_id IN (${placeholders(ids.length)}) ORDER BY cm.joined_at`,
    wsId,
    ...ids,
  );
  const unreadByChannel = new Map<string, number>();
  if (viewerUserId) {
    const unread = await all<{ channel_id: string; n: number }>(
      db,
      `SELECT m.channel_id, COUNT(*) AS n FROM messages m
       JOIN channel_members me ON me.channel_id = m.channel_id AND me.member_type = 'user' AND me.member_id = ?
       WHERE m.workspace_id = ? AND m.channel_id IN (${placeholders(ids.length)})
         AND m.created_at > me.last_read_at AND m.deleted_at IS NULL
         AND NOT (m.author_type = 'user' AND m.author_id = ?)
       GROUP BY m.channel_id`,
      viewerUserId,
      wsId,
      ...ids,
      viewerUserId,
    );
    for (const u of unread) unreadByChannel.set(u.channel_id, u.n);
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    section: r.section,
    topic: r.topic,
    humansOnly: bool(r.humans_only),
    isPrivate: bool(r.is_private),
    members: members.filter((m) => m.channel_id === r.id).map((m) => ({ type: m.member_type, id: m.member_id })),
    unread: unreadByChannel.get(r.id) ?? 0,
    lastMessageAt: r.last_message_at,
  }));
}

export async function channelDTO(db: D1Database, wsId: string, ch: ChannelRow, viewer: string | null) {
  const [dto] = await channelsToDTO(db, wsId, [ch], viewer);
  return dto!;
}

/** Publica `channel.upserted` para quem enxerga o canal (unread = 0, pois o evento é de todos). */
export async function publishChannel(ctx: HubCtx, ch: ChannelRow): Promise<ChannelDTO> {
  const dto = await channelDTO(ctx.env.DB, ctx.wsId, ch, null);
  await ctx.rt.publish({ type: "channel.upserted", channel: dto }, await channelAudience(ctx.env.DB, ch));
  return dto;
}

export function addChannelMemberStmt(db: D1Database, channelId: string, actor: ActorRef, now = Date.now()) {
  return stmt(
    db,
    `INSERT OR IGNORE INTO channel_members (channel_id, member_type, member_id, last_read_at, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
    channelId,
    actor.type,
    actor.id,
    now,
    now,
  );
}

/** Garante que o ator exista no workspace (pessoa membro ou agente). */
export async function assertActorInWorkspace(db: D1Database, wsId: string, actor: ActorRef): Promise<void> {
  const sql =
    actor.type === "user"
      ? "SELECT 1 AS one FROM members WHERE workspace_id = ? AND user_id = ?"
      : "SELECT 1 AS one FROM agents WHERE workspace_id = ? AND id = ?";
  const found = await first(db, sql, wsId, actor.id);
  if (!found) throw notFound(actor.type === "user" ? "Pessoa não encontrada neste workspace." : "Agente não encontrado.");
}

/** Busca ou cria a DM entre dois atores. Não faz checagens de permissão. */
export async function findOrCreateDm(
  db: D1Database,
  wsId: string,
  a: ActorRef,
  b: ActorRef,
  createdBy: string | null,
): Promise<{ channel: ChannelRow; created: boolean }> {
  if (a.type === b.type && a.id === b.id) throw forbidden("Não é possível abrir uma DM consigo mesmo.");
  const key = dmKey(a, b);
  const existing = await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND dm_key = ?", wsId, key);
  if (existing) return { channel: existing, created: false };
  const now = Date.now();
  const id = newId();
  const inserted = await run(
    db,
    `INSERT OR IGNORE INTO channels (id, workspace_id, kind, name, section, topic, humans_only, is_private, dm_key, created_by, created_at, last_message_at)
     VALUES (?, ?, 'dm', NULL, NULL, NULL, 0, 1, ?, ?, ?, NULL)`,
    id,
    wsId,
    key,
    createdBy,
    now,
  );
  if (inserted === 1) {
    await db.batch([addChannelMemberStmt(db, id, a, now), addChannelMemberStmt(db, id, b, now)]);
  }
  // Se outra requisição criou a mesma DM ao mesmo tempo, o UNIQUE (workspace_id, dm_key) devolve a dela.
  const channel = await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND dm_key = ?", wsId, key);
  if (!channel) throw new Error("falha ao criar DM");
  return { channel, created: inserted === 1 };
}
