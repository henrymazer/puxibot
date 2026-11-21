import { Hono, type Context } from "hono";
import { z } from "zod";
import { forbidden } from "../lib/errors";
import { readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { userActor } from "../domain/actor";
import { deleteFile, fileContentResponse, listFiles, requireVisibleFile, updateFile, uploadFromRequest } from "../domain/files";
import { toFileDTO, type FileRow } from "../domain/rows";

/** /api/workspaces/:ws/files (drive e anexos) */
export const fileRoutes = new Hono<WsEnv>();

const actor = (c: Context<WsEnv>) => userActor(c.get("userId"), isAdmin(c));

function assertAuthorOrAdmin(c: Context<WsEnv>, file: FileRow) {
  const isAuthor = file.author_type === "user" && file.author_id === c.get("userId");
  if (!isAuthor && !isAdmin(c)) throw forbidden("Só quem enviou o arquivo ou um admin pode mudá-lo.");
}

fileRoutes.get("/files", async (c) => {
  const folder = c.req.query("folder");
  const items = await listFiles(c.env.DB, c.get("wsId"), actor(c), { folder: folder ?? null, q: c.req.query("q") || undefined });
  return c.json({ items });
});

fileRoutes.post("/files", async (c) => c.json(await uploadFromRequest(c.get("hub"), actor(c), c.req.raw), 201));

fileRoutes.get("/files/:id", async (c) => {
  const file = await requireVisibleFile(c.env.DB, c.get("wsId"), actor(c), c.req.param("id"));
  return c.json(toFileDTO(file));
});

fileRoutes.get("/files/:id/content", async (c) => {
  const file = await requireVisibleFile(c.env.DB, c.get("wsId"), actor(c), c.req.param("id"));
  const inline = c.req.query("inline") === "1" || c.req.query("inline") === "true";
  return fileContentResponse(c.env, file, inline);
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  folder: z.string().max(200).nullable().optional(),
  inDrive: z.boolean().optional(),
});

fileRoutes.patch("/files/:id", async (c) => {
  const file = await requireVisibleFile(c.env.DB, c.get("wsId"), actor(c), c.req.param("id"));
  assertAuthorOrAdmin(c, file);
  const body = await readBody(c, patchSchema);
  return c.json(await updateFile(c.get("hub"), file, body));
});

fileRoutes.delete("/files/:id", async (c) => {
  const file = await requireVisibleFile(c.env.DB, c.get("wsId"), actor(c), c.req.param("id"));
  assertAuthorOrAdmin(c, file);
  await deleteFile(c.get("hub"), file);
  return c.body(null, 204);
});
