import type { FileDTO } from "@puxibot/shared";
import { all, bool, first, newId, run, type SqlValue } from "../lib/db";
import { badRequest, HttpError, notFound } from "../lib/errors";
import { likePattern, type Actor } from "./actor";
import { channelAudience, getChannel, isChannelMember, isOpenChannel } from "./channels";
import type { HubCtx } from "./context";
import { toFileDTO, type ChannelRow, type FileRow } from "./rows";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function getFileRow(db: D1Database, wsId: string, id: string): Promise<FileRow | null> {
  return first<FileRow>(db, "SELECT * FROM files WHERE workspace_id = ? AND id = ?", wsId, id);
}

/**
 * SQL que restringe `files f` aos arquivos que o ator enxerga: sem canal, ou de canal visível
 * (pessoa: canal aberto ou membro; agente: membro, ou canal aberto que não seja só de humanos).
 * Anexo sem canal (`in_drive = 0`, ainda não enviado) só é visível ao autor.
 */
export function fileVisibilitySql(actor: Actor): { sql: string; params: SqlValue[] } {
  const open = actor.ref.type === "user" ? "(c.kind = 'channel' AND c.is_private = 0)" : "(c.kind = 'channel' AND c.is_private = 0 AND c.humans_only = 0)";
  const member = "EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_type = ? AND cm.member_id = ?)";
  // Agente: além de ele ser membro, a pessoa por quem age também precisa ser (canal privado/DM).
  const isAgent = actor.ref.type === "agent";
  const memberSql = isAgent ? `(${member} AND ${member})` : member;
  const memberParams: SqlValue[] = isAgent ? ["agent", actor.ref.id, "user", actor.principalUserId] : ["user", actor.ref.id];
  return {
    sql: `(
      (f.channel_id IS NULL AND (f.in_drive = 1 OR (f.author_type = ? AND f.author_id = ?)))
      OR EXISTS (
        SELECT 1 FROM channels c WHERE c.id = f.channel_id AND c.workspace_id = f.workspace_id
          AND (${isAgent ? "c.humans_only = 0 AND " : ""}(${open} OR ${memberSql}))
      )
    )`,
    params: [actor.ref.type, actor.ref.id, ...memberParams],
  };
}

export async function canSeeFile(db: D1Database, actor: Actor, file: FileRow): Promise<boolean> {
  const vis = fileVisibilitySql(actor);
  const row = await first(db, `SELECT 1 AS one FROM files f WHERE f.workspace_id = ? AND f.id = ? AND ${vis.sql}`, file.workspace_id, file.id, ...vis.params);
  return row != null;
}

export async function requireVisibleFile(db: D1Database, wsId: string, actor: Actor, id: string): Promise<FileRow> {
  const file = await getFileRow(db, wsId, id);
  if (!file || !(await canSeeFile(db, actor, file))) throw notFound("Arquivo não encontrado.");
  return file;
}

export async function listFiles(
  db: D1Database,
  wsId: string,
  actor: Actor,
  f: { folder?: string | null; q?: string; limit?: number },
): Promise<FileDTO[]> {
  const vis = fileVisibilitySql(actor);
  let sql = `SELECT f.* FROM files f WHERE f.workspace_id = ? AND f.in_drive = 1 AND ${vis.sql}`;
  const params: SqlValue[] = [wsId, ...vis.params];
  if (f.folder !== undefined && f.folder !== null) {
    if (f.folder === "") sql += " AND f.folder IS NULL";
    else {
      sql += " AND f.folder = ?";
      params.push(f.folder);
    }
  }
  if (f.q) {
    sql += " AND f.name LIKE ? ESCAPE '\\'";
    params.push(likePattern(f.q));
  }
  sql += " ORDER BY f.created_at DESC LIMIT ?";
  params.push(Math.min(Math.max(f.limit ?? 200, 1), 500));
  return (await all<FileRow>(db, sql, ...params)).map(toFileDTO);
}

/** O ator pode anexar/publicar neste canal? */
export async function assertCanUseChannel(db: D1Database, actor: Actor, ch: ChannelRow | null): Promise<void> {
  if (!ch) throw notFound("Canal não encontrado.");
  if (actor.ref.type === "agent" && bool(ch.humans_only)) throw notFound("Canal não encontrado.");
  if (isOpenChannel(ch)) return;
  if (!(await isChannelMember(db, ch.id, actor.ref))) throw notFound("Canal não encontrado.");
  if (actor.ref.type === "agent" && !(await isChannelMember(db, ch.id, { type: "user", id: actor.principalUserId }))) {
    throw notFound("Canal não encontrado.");
  }
}

/** Tipo declarado pelo navegador (controlado por quem envia): só `tipo/subtipo` simples, em minúsculas. */
export function sanitizeMime(raw: string | null | undefined): string {
  const t = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(t) ? t : "application/octet-stream";
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]+/g, "_").trim().slice(0, 200);
  return clean || "arquivo";
}

function normalizeFolder(folder: string | null | undefined): string | null {
  if (folder == null) return null;
  const f = folder.trim().replace(/^\/+|\/+$/g, "").slice(0, 200);
  return f || null;
}

function truthy(v: File | string | null | undefined, def: boolean): boolean {
  if (v == null || v === "") return def;
  return !["0", "false", "no", "nao", "não"].includes(String(v).toLowerCase());
}

/**
 * Upload `multipart/form-data` (`file`, `folder?`, `channelId?`, `inDrive?`) para o R2 em `ws/<ws>/<id>/<nome>`.
 * Limite: 25 MB (confere `Content-Length` antes de ler o corpo e o tamanho do arquivo depois).
 */
export async function uploadFromRequest(ctx: HubCtx, actor: Actor, req: Request): Promise<FileDTO> {
  const db = ctx.env.DB;
  // O formulário é lido inteiro na memória: sem Content-Length (corpo em stream) não dá para limitar antes.
  const lengthHeader = req.headers.get("Content-Length");
  if (lengthHeader == null || lengthHeader.trim() === "") {
    throw new HttpError(411, "length_required", "Envie o arquivo com Content-Length (upload em stream não é aceito).");
  }
  const declared = Number(lengthHeader);
  if (!Number.isFinite(declared) || declared < 0) throw badRequest("Content-Length inválido.");
  if (declared > MAX_FILE_BYTES + 64 * 1024) throw new HttpError(413, "file_too_large", "O arquivo passa do limite de 25 MB.");
  if (!(req.headers.get("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw badRequest("Envie o arquivo como multipart/form-data, no campo \"file\".");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest("Não consegui ler o formulário enviado.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw badRequest("Campo \"file\" ausente.");
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large", "O arquivo passa do limite de 25 MB.");
  const channelIdRaw = form.get("channelId");
  const channelId = typeof channelIdRaw === "string" && channelIdRaw ? channelIdRaw : null;
  let channel: ChannelRow | null = null;
  if (channelId) {
    channel = await getChannel(db, ctx.wsId, channelId);
    await assertCanUseChannel(db, actor, channel);
  }
  const folderRaw = form.get("folder");
  const name = sanitizeName(file.name || "arquivo");
  const mime = sanitizeMime(file.type);
  const id = newId();
  const key = `ws/${ctx.wsId}/${id}/${name}`;
  await ctx.env.FILES.put(key, file, { httpMetadata: { contentType: mime } });
  const row: FileRow = {
    id,
    workspace_id: ctx.wsId,
    r2_key: key,
    name,
    mime,
    size: file.size,
    folder: normalizeFolder(typeof folderRaw === "string" ? folderRaw : null),
    author_type: actor.ref.type,
    author_id: actor.ref.id,
    channel_id: channel?.id ?? null,
    in_drive: truthy(form.get("inDrive"), true) ? 1 : 0,
    created_at: Date.now(),
    on_behalf_of_user_id: actor.onBehalfOfUserId,
  };
  try {
    await run(
      db,
      `INSERT INTO files (id, workspace_id, r2_key, name, mime, size, folder, author_type, author_id, channel_id, in_drive, created_at, on_behalf_of_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.workspace_id,
      row.r2_key,
      row.name,
      row.mime,
      row.size,
      row.folder,
      row.author_type,
      row.author_id,
      row.channel_id,
      row.in_drive,
      row.created_at,
      row.on_behalf_of_user_id,
    );
  } catch (err) {
    await ctx.env.FILES.delete(key);
    throw err;
  }
  const dto = toFileDTO(row);
  if (row.in_drive === 1) await ctx.rt.publish({ type: "file.created", file: dto }, channel ? await channelAudience(db, channel) : null);
  return dto;
}

/** Tipos que podem abrir no navegador (com `?inline=1`); o resto sempre baixa, para não executar HTML/SVG na origem do app. */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;

export async function fileContentResponse(env: { FILES: R2Bucket }, file: FileRow, inline: boolean): Promise<Response> {
  const obj = await env.FILES.get(file.r2_key);
  if (!obj) throw notFound("O conteúdo do arquivo não está mais disponível.");
  const asciiName = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // Tipos que o navegador executaria (HTML, SVG, XML, JS...) nunca saem com o tipo original na origem do app.
  const safe = INLINE_SAFE.test(file.mime);
  const disposition = inline && safe ? "inline" : "attachment";
  const headers = new Headers({
    "Content-Type": safe ? file.mime : "application/octet-stream",
    "Content-Length": String(obj.size),
    "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "X-Content-Type-Options": "nosniff",
    // Mesmo aberto no navegador, o arquivo não roda script nem carrega nada; só a interface do próprio hub o emoldura.
    "Content-Security-Policy": disposition === "inline" ? "sandbox; default-src 'none'; frame-ancestors 'self'" : "sandbox; default-src 'none'; frame-ancestors 'none'",
    "Cache-Control": "private, max-age=300",
    ETag: obj.httpEtag,
  });
  return new Response(obj.body, { headers });
}

export async function updateFile(
  ctx: HubCtx,
  file: FileRow,
  input: { name?: string; folder?: string | null; inDrive?: boolean },
): Promise<FileDTO> {
  const next: FileRow = {
    ...file,
    name: input.name !== undefined ? sanitizeName(input.name) : file.name,
    folder: input.folder !== undefined ? normalizeFolder(input.folder) : file.folder,
    in_drive: input.inDrive !== undefined ? (input.inDrive ? 1 : 0) : file.in_drive,
  };
  await run(
    ctx.env.DB,
    "UPDATE files SET name = ?, folder = ?, in_drive = ? WHERE workspace_id = ? AND id = ?",
    next.name,
    next.folder,
    next.in_drive,
    ctx.wsId,
    file.id,
  );
  const dto = toFileDTO(next);
  if (next.in_drive === 1) {
    const ch = next.channel_id ? await getChannel(ctx.env.DB, ctx.wsId, next.channel_id) : null;
    await ctx.rt.publish({ type: "file.created", file: dto }, ch ? await channelAudience(ctx.env.DB, ch) : null);
  }
  return dto;
}

export async function deleteFile(ctx: HubCtx, file: FileRow): Promise<void> {
  await ctx.env.FILES.delete(file.r2_key);
  await run(ctx.env.DB, "DELETE FROM files WHERE workspace_id = ? AND id = ?", ctx.wsId, file.id);
}
