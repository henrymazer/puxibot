import type { ActorRef, WikiGraphDTO, WikiPageDTO, WikiStatsDTO } from "@puxibot/shared";
import { all, first, newId, run, stmt } from "../lib/db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { likePattern, type Actor } from "./actor";
import type { HubCtx } from "./context";
import { toWikiPageDTO, type WikiPageRow } from "./rows";

export async function getPage(db: D1Database, wsId: string, id: string): Promise<WikiPageRow | null> {
  return first<WikiPageRow>(db, "SELECT * FROM wiki_pages WHERE workspace_id = ? AND id = ?", wsId, id);
}

export async function requirePage(db: D1Database, wsId: string, id: string, opts: { allowDeleted?: boolean } = {}) {
  const row = await getPage(db, wsId, id);
  if (!row || (row.deleted_at != null && !opts.allowDeleted)) throw notFound("Página não encontrada.");
  return row;
}

/** Página ativa pelo título (sem diferenciar maiúsculas). */
export async function findPageByTitle(db: D1Database, wsId: string, title: string): Promise<WikiPageRow | null> {
  return first<WikiPageRow>(
    db,
    "SELECT * FROM wiki_pages WHERE workspace_id = ? AND deleted_at IS NULL AND lower(title) = lower(?) ORDER BY is_folder, created_at LIMIT 1",
    wsId,
    title.trim(),
  );
}

export async function listTree(db: D1Database, wsId: string, trash = false): Promise<WikiPageDTO[]> {
  const rows = await all<WikiPageRow>(
    db,
    `SELECT * FROM wiki_pages WHERE workspace_id = ? AND deleted_at IS ${trash ? "NOT NULL" : "NULL"}
     ORDER BY is_folder DESC, title COLLATE NOCASE LIMIT 2000`,
    wsId,
  );
  return rows.map((r) => toWikiPageDTO(r, false));
}

async function publishChange(ctx: HubCtx, pageId: string): Promise<void> {
  await ctx.rt.publish({ type: "wiki.changed", pageId }, null);
}

async function assertParent(db: D1Database, wsId: string, parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return;
  const parent = await requirePage(db, wsId, parentId);
  // Evita ciclos ao mover: o novo pai não pode ser a própria página nem um descendente dela.
  let cursor: WikiPageRow | null = parent;
  for (let i = 0; cursor && i < 100; i++) {
    if (cursor.id === selfId) throw badRequest("Uma página não pode ficar dentro dela mesma.");
    cursor = cursor.parent_id ? await getPage(db, wsId, cursor.parent_id) : null;
  }
}

function revisionStmt(db: D1Database, page: Pick<WikiPageRow, "id" | "title" | "body">, version: number, actor: Actor, note: string | null, now: number) {
  return stmt(
    db,
    `INSERT INTO wiki_revisions (id, page_id, version, title, body, author_type, author_id, on_behalf_of_user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    page.id,
    version,
    page.title,
    page.body,
    actor.ref.type,
    actor.ref.id,
    actor.onBehalfOfUserId,
    note,
    now,
  );
}

export async function createPage(
  ctx: HubCtx,
  actor: Actor,
  input: { title: string; body?: string; parentId?: string | null; isFolder?: boolean; note?: string | null },
): Promise<WikiPageDTO> {
  const db = ctx.env.DB;
  await assertParent(db, ctx.wsId, input.parentId);
  const id = newId();
  const now = Date.now();
  const body = input.isFolder ? "" : (input.body ?? "");
  await db.batch([
    stmt(
      db,
      `INSERT INTO wiki_pages (id, workspace_id, parent_id, is_folder, title, body, version, deleted_at, created_by_type, created_by_id,
         updated_by_type, updated_by_id, on_behalf_of_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ctx.wsId,
      input.parentId ?? null,
      input.isFolder ? 1 : 0,
      input.title,
      body,
      actor.ref.type,
      actor.ref.id,
      actor.ref.type,
      actor.ref.id,
      actor.onBehalfOfUserId,
      now,
      now,
    ),
    revisionStmt(db, { id, title: input.title, body }, 1, actor, input.note ?? null, now),
  ]);
  await publishChange(ctx, id);
  return toWikiPageDTO((await getPage(db, ctx.wsId, id))!);
}

/**
 * Edita a página e cria uma revisão. Com `baseVersion`, a gravação só acontece se a versão atual ainda for essa
 * (UPDATE condicional, atômico); se outra pessoa salvou antes, 409 `wiki_conflict`.
 */
export async function updatePage(
  ctx: HubCtx,
  actor: Actor,
  page: WikiPageRow,
  input: { title?: string; body?: string; parentId?: string | null; note?: string | null; baseVersion?: number },
): Promise<WikiPageDTO> {
  const db = ctx.env.DB;
  if (input.parentId !== undefined) await assertParent(db, ctx.wsId, input.parentId, page.id);
  const title = input.title ?? page.title;
  const body = page.is_folder ? "" : (input.body ?? page.body);
  const parentId = input.parentId === undefined ? page.parent_id : input.parentId;
  const now = Date.now();
  const updated = await first<{ version: number }>(
    db,
    `UPDATE wiki_pages SET title = ?, body = ?, parent_id = ?, version = version + 1, updated_by_type = ?, updated_by_id = ?,
       on_behalf_of_user_id = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL AND (? IS NULL OR version = ?)
     RETURNING version`,
    title,
    body,
    parentId,
    actor.ref.type,
    actor.ref.id,
    actor.onBehalfOfUserId,
    now,
    ctx.wsId,
    page.id,
    input.baseVersion ?? null,
    input.baseVersion ?? null,
  );
  if (!updated) {
    const current = await getPage(db, ctx.wsId, page.id);
    if (!current || current.deleted_at != null) throw notFound("Página não encontrada.");
    throw conflict(
      `Esta página foi alterada por outra pessoa (versão atual ${current.version}, você editou a ${input.baseVersion}). Recarregue e aplique suas mudanças de novo.`,
      "wiki_conflict",
    );
  }
  await revisionStmt(db, { id: page.id, title, body }, updated.version, actor, input.note ?? null, now).run();
  await publishChange(ctx, page.id);
  return toWikiPageDTO((await getPage(db, ctx.wsId, page.id))!);
}

/** Ids da página e de todos os descendentes. */
async function subtreeIds(db: D1Database, wsId: string, rootId: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM wiki_pages WHERE workspace_id = ? AND id = ?
       UNION SELECT p.id FROM wiki_pages p JOIN sub ON p.parent_id = sub.id WHERE p.workspace_id = ?
     ) SELECT id FROM sub`,
    wsId,
    rootId,
    wsId,
  );
  return rows.map((r) => r.id);
}

/** Manda para a lixeira (com os descendentes ainda ativos, marcados no mesmo instante). */
export async function trashPage(ctx: HubCtx, page: WikiPageRow): Promise<void> {
  const db = ctx.env.DB;
  const now = Date.now();
  const ids = await subtreeIds(db, ctx.wsId, page.id);
  await db.batch(
    ids.map((id) => stmt(db, "UPDATE wiki_pages SET deleted_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL", now, ctx.wsId, id)),
  );
  await publishChange(ctx, page.id);
}

export async function deletePagePermanently(ctx: HubCtx, page: WikiPageRow): Promise<void> {
  await run(ctx.env.DB, "DELETE FROM wiki_pages WHERE workspace_id = ? AND id = ?", ctx.wsId, page.id);
  await publishChange(ctx, page.id);
}

/** Restaura a página e os descendentes que foram para a lixeira junto com ela. Pai ainda na lixeira: vai para a raiz. */
export async function restorePage(ctx: HubCtx, page: WikiPageRow): Promise<WikiPageDTO> {
  const db = ctx.env.DB;
  if (page.deleted_at == null) return toWikiPageDTO(page);
  const ids = await subtreeIds(db, ctx.wsId, page.id);
  const statements = ids.map((id) =>
    stmt(db, "UPDATE wiki_pages SET deleted_at = NULL WHERE workspace_id = ? AND id = ? AND deleted_at = ?", ctx.wsId, id, page.deleted_at),
  );
  if (page.parent_id) {
    const parent = await getPage(db, ctx.wsId, page.parent_id);
    if (!parent || parent.deleted_at != null) {
      statements.push(stmt(db, "UPDATE wiki_pages SET parent_id = NULL WHERE workspace_id = ? AND id = ?", ctx.wsId, page.id));
    }
  }
  await db.batch(statements);
  await publishChange(ctx, page.id);
  return toWikiPageDTO((await getPage(db, ctx.wsId, page.id))!);
}

export async function recordRead(db: D1Database, pageId: string, reader: ActorRef): Promise<void> {
  await run(db, "INSERT INTO wiki_reads (page_id, reader_type, reader_id, created_at) VALUES (?, ?, ?, ?)", pageId, reader.type, reader.id, Date.now());
}

/** Títulos citados com [[Título]] (ou [[Título|texto]]) no corpo. */
export function wikiLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|\n]{1,200})(?:\|[^\]\n]*)?\]\]/g)) out.add(m[1]!.trim().toLowerCase());
  return [...out];
}

export async function wikiGraph(db: D1Database, wsId: string): Promise<WikiGraphDTO> {
  const pages = await all<{ id: string; title: string; body: string }>(
    db,
    "SELECT id, title, body FROM wiki_pages WHERE workspace_id = ? AND deleted_at IS NULL AND is_folder = 0 LIMIT 2000",
    wsId,
  );
  const byTitle = new Map<string, string>();
  for (const p of pages) if (!byTitle.has(p.title.trim().toLowerCase())) byTitle.set(p.title.trim().toLowerCase(), p.id);
  const edges: WikiGraphDTO["edges"] = [];
  for (const p of pages) {
    for (const t of wikiLinks(p.body)) {
      const to = byTitle.get(t);
      if (to && to !== p.id) edges.push({ from: p.id, to });
    }
  }
  return { nodes: pages.map((p) => ({ id: p.id, title: p.title })), edges };
}

function excerpt(body: string, needle: string): string {
  const i = body.toLowerCase().indexOf(needle.toLowerCase());
  const start = Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + body.slice(start, start + 180).replace(/\s+/g, " ").trim();
}

/** Métricas da página. `mentionedIn` respeita os canais que o leitor enxerga (`visibleChannelSql` filtra `m.channel_id`). */
export async function wikiStats(db: D1Database, wsId: string, page: WikiPageRow, viewerUserId: string): Promise<WikiStatsDTO> {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const [reads, readers, pages, messages] = await Promise.all([
    first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wiki_reads WHERE page_id = ? AND created_at >= ?", page.id, weekAgo),
    all<{ reader_type: "user" | "agent"; reader_id: string; n: number; last_at: number }>(
      db,
      `SELECT reader_type, reader_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM wiki_reads
       WHERE page_id = ? AND created_at >= ? GROUP BY reader_type, reader_id ORDER BY n DESC LIMIT 50`,
      page.id,
      Date.now() - 30 * 86_400_000,
    ),
    all<{ id: string; title: string; body: string }>(
      db,
      `SELECT id, title, body FROM wiki_pages WHERE workspace_id = ? AND deleted_at IS NULL AND id <> ? AND body LIKE ? ESCAPE '\\' LIMIT 20`,
      wsId,
      page.id,
      likePattern(`[[${page.title}`),
    ),
    all<{ id: string; body: string; channel_name: string | null }>(
      db,
      `SELECT m.id, m.body, c.name AS channel_name FROM messages m JOIN channels c ON c.id = m.channel_id
       LEFT JOIN channel_members me ON me.channel_id = c.id AND me.member_type = 'user' AND me.member_id = ?
       WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\'
         AND ((c.kind = 'channel' AND c.is_private = 0) OR me.member_id IS NOT NULL)
       ORDER BY m.created_at DESC LIMIT 20`,
      viewerUserId,
      wsId,
      likePattern(`[[${page.title}`),
    ),
  ]);
  const needle = `[[${page.title}`;
  return {
    readsThisWeek: reads?.n ?? 0,
    readers: readers.map((r) => ({ reader: { type: r.reader_type, id: r.reader_id }, count: r.n, lastAt: r.last_at })),
    mentionedIn: [
      ...pages.filter((p) => wikiLinks(p.body).includes(page.title.trim().toLowerCase())).map((p) => ({
        kind: "page" as const,
        id: p.id,
        title: p.title,
        excerpt: excerpt(p.body, needle),
      })),
      ...messages.map((m) => ({
        kind: "message" as const,
        id: m.id,
        title: m.channel_name ? `#${m.channel_name}` : "Mensagem direta",
        excerpt: excerpt(m.body, needle),
      })),
    ],
  };
}
