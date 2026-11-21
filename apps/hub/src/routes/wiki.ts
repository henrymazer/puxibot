import { Hono, type Context } from "hono";
import { z } from "zod";
import { all } from "../lib/db";
import { readBody } from "../lib/validate";
import { assertAdmin, isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { userActor } from "../domain/actor";
import { toWikiPageDTO, toWikiRevisionDTO, type WikiRevisionRow } from "../domain/rows";
import {
  createPage,
  deletePagePermanently,
  listTree,
  recordRead,
  requirePage,
  restorePage,
  trashPage,
  updatePage,
  wikiGraph,
  wikiStats,
} from "../domain/wiki";

/** /api/workspaces/:ws/wiki e /wiki-graph */
export const wikiRoutes = new Hono<WsEnv>();

const actor = (c: Context<WsEnv>) => userActor(c.get("userId"), isAdmin(c));

wikiRoutes.get("/wiki", async (c) => {
  const trash = c.req.query("trash") === "1" || c.req.query("trash") === "true";
  return c.json({ items: await listTree(c.env.DB, c.get("wsId"), trash) });
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(200_000).optional(),
  parentId: z.string().nullable().optional(),
  isFolder: z.boolean().optional(),
  note: z.string().max(300).optional(),
});

wikiRoutes.post("/wiki", async (c) => {
  const body = await readBody(c, createSchema);
  return c.json(await createPage(c.get("hub"), actor(c), body), 201);
});

wikiRoutes.get("/wiki/:id", async (c) => {
  const page = await requirePage(c.env.DB, c.get("wsId"), c.req.param("id"), { allowDeleted: true });
  if (page.deleted_at == null) await recordRead(c.env.DB, page.id, { type: "user", id: c.get("userId") });
  return c.json(toWikiPageDTO(page));
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
  parentId: z.string().nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  baseVersion: z.number().int().min(1).optional(),
});

wikiRoutes.patch("/wiki/:id", async (c) => {
  const page = await requirePage(c.env.DB, c.get("wsId"), c.req.param("id"));
  const body = await readBody(c, patchSchema);
  return c.json(await updatePage(c.get("hub"), actor(c), page, body));
});

wikiRoutes.delete("/wiki/:id", async (c) => {
  const permanent = c.req.query("permanent") === "1" || c.req.query("permanent") === "true";
  const page = await requirePage(c.env.DB, c.get("wsId"), c.req.param("id"), { allowDeleted: permanent });
  if (permanent) {
    assertAdmin(c, "Só admins apagam páginas de vez.");
    await deletePagePermanently(c.get("hub"), page);
  } else {
    await trashPage(c.get("hub"), page);
  }
  return c.body(null, 204);
});

wikiRoutes.post("/wiki/:id/restore", async (c) => {
  const page = await requirePage(c.env.DB, c.get("wsId"), c.req.param("id"), { allowDeleted: true });
  return c.json(await restorePage(c.get("hub"), page));
});

wikiRoutes.get("/wiki/:id/revisions", async (c) => {
  const page = await requirePage(c.env.DB, c.get("wsId"), c.req.param("id"), { allowDeleted: true });
  const rows = await all<WikiRevisionRow>(
    c.env.DB,
    "SELECT * FROM wiki_revisions WHERE page_id = ? ORDER BY version DESC LIMIT 200",
    page.id,
  );
  return c.json({ items: rows.map(toWikiRevisionDTO) });
});

wikiRoutes.get("/wiki/:id/stats", async (c) => {
  const page = await requirePage(c.env.DB, c.get("wsId"), c.req.param("id"), { allowDeleted: true });
  return c.json(await wikiStats(c.env.DB, c.get("wsId"), page, c.get("userId")));
});

wikiRoutes.get("/wiki-graph", async (c) => c.json(await wikiGraph(c.env.DB, c.get("wsId"))));
