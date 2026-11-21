import type { ActorRef, AttachmentDTO, MessageCard, MessageDTO } from "@puxibot/shared";
import { all, first, newId, placeholders, stmt } from "../lib/db";
import { notFound } from "../lib/errors";
import type { HubCtx } from "./context";
import { channelAudience, getChannel } from "./channels";
import { toMessageDTO, type ChannelRow, type MessageRow } from "./rows";

export async function getMessageRow(db: D1Database, wsId: string, messageId: string): Promise<MessageRow | null> {
  return first<MessageRow>(db, "SELECT * FROM messages WHERE workspace_id = ? AND id = ?", wsId, messageId);
}

export async function requireMessageRow(db: D1Database, wsId: string, messageId: string): Promise<MessageRow> {
  const row = await getMessageRow(db, wsId, messageId);
  if (!row) throw notFound("Mensagem não encontrada.");
  return row;
}

/** Converte linhas em DTOs com contagem de respostas e reações (2 consultas para a lista toda). */
export async function messagesToDTO(db: D1Database, wsId: string, rows: MessageRow[]): Promise<MessageDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);
  const [replies, reactions] = await Promise.all([
    all<{ thread_root_id: string; n: number }>(
      db,
      `SELECT thread_root_id, COUNT(*) AS n FROM messages
       WHERE workspace_id = ? AND thread_root_id IN (${ph}) AND deleted_at IS NULL GROUP BY thread_root_id`,
      wsId,
      ...ids,
    ),
    all<{ message_id: string; emoji: string; user_id: string }>(
      db,
      `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`,
      ...ids,
    ),
  ]);
  return rows.map((r) => {
    const grouped = new Map<string, string[]>();
    for (const re of reactions) {
      if (re.message_id !== r.id) continue;
      const list = grouped.get(re.emoji) ?? [];
      list.push(re.user_id);
      grouped.set(re.emoji, list);
    }
    return toMessageDTO(r, {
      replyCount: replies.find((x) => x.thread_root_id === r.id)?.n ?? 0,
      reactions: [...grouped].map(([emoji, userIds]) => ({ emoji, userIds })),
    });
  });
}

export async function messageDTO(db: D1Database, wsId: string, row: MessageRow): Promise<MessageDTO> {
  const [dto] = await messagesToDTO(db, wsId, [row]);
  return dto!;
}

export interface InsertMessageInput {
  channel: ChannelRow;
  author: { type: "user" | "agent" | "system"; id: string | null };
  body: string;
  threadRootId?: string | null;
  quote?: { messageId: string; text: string } | null;
  attachments?: AttachmentDTO[];
  cards?: MessageCard[];
  mentions?: ActorRef[];
  jobId?: string | null;
  meta?: MessageDTO["meta"];
  onBehalfOfUserId?: string | null;
}

/**
 * Grava a mensagem, atualiza `last_message_at` e publica `message.created`
 * (e `message.updated` da raiz, quando é resposta em thread). Não dispara roteamento.
 */
export async function insertMessage(ctx: HubCtx, input: InsertMessageInput): Promise<MessageDTO> {
  const db = ctx.env.DB;
  const now = Date.now();
  const row: MessageRow = {
    id: newId(),
    workspace_id: ctx.wsId,
    channel_id: input.channel.id,
    author_type: input.author.type,
    author_id: input.author.id,
    body: input.body,
    thread_root_id: input.threadRootId ?? null,
    quote_json: input.quote ? JSON.stringify(input.quote) : null,
    attachments_json: JSON.stringify(input.attachments ?? []),
    cards_json: JSON.stringify(input.cards ?? []),
    mentions_json: JSON.stringify(input.mentions ?? []),
    job_id: input.jobId ?? null,
    meta_json: input.meta ? JSON.stringify(input.meta) : null,
    pinned: 0,
    edited_at: null,
    deleted_at: null,
    created_at: now,
    on_behalf_of_user_id: input.onBehalfOfUserId ?? null,
  };
  await db.batch([
    stmt(
      db,
      `INSERT INTO messages (id, workspace_id, channel_id, author_type, author_id, body, thread_root_id, quote_json,
         attachments_json, cards_json, mentions_json, job_id, meta_json, pinned, edited_at, deleted_at, created_at, on_behalf_of_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
      row.id,
      row.workspace_id,
      row.channel_id,
      row.author_type,
      row.author_id,
      row.body,
      row.thread_root_id,
      row.quote_json,
      row.attachments_json,
      row.cards_json,
      row.mentions_json,
      row.job_id,
      row.meta_json,
      row.created_at,
      row.on_behalf_of_user_id,
    ),
    stmt(db, "UPDATE channels SET last_message_at = ? WHERE workspace_id = ? AND id = ?", now, ctx.wsId, input.channel.id),
  ]);
  // Quem manda mensagem leu o canal até aqui.
  if (input.author.type === "user" && input.author.id) {
    await db
      .prepare(
        "UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND member_type = 'user' AND member_id = ?",
      )
      .bind(now, input.channel.id, input.author.id)
      .run();
  }
  const dto = toMessageDTO(row, { replyCount: 0, reactions: [] });
  const audience = await channelAudience(db, input.channel);
  await ctx.rt.publish({ type: "message.created", message: dto }, audience);
  if (row.thread_root_id) {
    const root = await getMessageRow(db, ctx.wsId, row.thread_root_id);
    if (root) await ctx.rt.publish({ type: "message.updated", message: await messageDTO(db, ctx.wsId, root) }, audience);
  }
  return dto;
}

export async function postSystemMessage(
  ctx: HubCtx,
  channelOrId: ChannelRow | string,
  body: string,
  threadRootId: string | null = null,
): Promise<MessageDTO | null> {
  const channel = typeof channelOrId === "string" ? await getChannel(ctx.env.DB, ctx.wsId, channelOrId) : channelOrId;
  if (!channel) return null;
  return insertMessage(ctx, { channel, author: { type: "system", id: null }, body, threadRootId });
}

export async function publishMessageUpdated(ctx: HubCtx, row: MessageRow): Promise<MessageDTO> {
  const channel = await getChannel(ctx.env.DB, ctx.wsId, row.channel_id);
  const dto = await messageDTO(ctx.env.DB, ctx.wsId, row);
  if (channel) await ctx.rt.publish({ type: "message.updated", message: dto }, await channelAudience(ctx.env.DB, channel));
  return dto;
}
