import { Hono } from "hono";
import { z } from "zod";
import { bool, first, newId, run } from "../lib/db";
import { readBody } from "../lib/validate";
import { assertAdmin, isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { userActor } from "../domain/actor";
import { insertMessage } from "../domain/messages";
import { canSeeChannel } from "../domain/channels";
import { routeMessage } from "../domain/routing";
import type { ChannelRow } from "../domain/rows";
import { searchWorkspace } from "../domain/search";
import { createStarterTeam } from "../domain/starterTeam";
import { getWorkspaceRow } from "../domain/workspaces";

/** /api/workspaces/:ws/search, /feedback, /starter-team */
export const miscRoutes = new Hono<WsEnv>();

miscRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  return c.json(await searchWorkspace(c.env.DB, c.get("wsId"), userActor(c.get("userId"), isAdmin(c)), q));
});

/** Grava o feedback e, se existir o canal `feedbacks` (ou `feedback`), publica nele como mensagem da pessoa. */
miscRoutes.post("/feedback", async (c) => {
  const { body } = await readBody(c, z.object({ body: z.string().trim().min(1).max(5000) }));
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const id = newId();
  const now = Date.now();
  await run(db, "INSERT INTO feedback (id, workspace_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)", id, wsId, userId, body, now);
  const channel = await first<ChannelRow>(
    db,
    "SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name IN ('feedbacks','feedback') ORDER BY name DESC LIMIT 1",
    wsId,
  );
  let messageId: string | null = null;
  // Só publica se a pessoa enxerga o canal (um #feedbacks privado não recebe mensagem de quem está fora dele).
  if (channel && (await canSeeChannel(db, channel, userId))) {
    const hub = c.get("hub");
    const message = await insertMessage(hub, { channel, author: { type: "user", id: userId }, body: `**Feedback:** ${body}` });
    messageId = message.id;
    const workspace = await getWorkspaceRow(db, wsId);
    await routeMessage(hub, { channel, message, userId, mentionedAgents: [], routerEnabled: bool(workspace?.router_enabled) });
  }
  return c.json({ id, createdAt: now, channelId: messageId ? channel!.id : null, messageId }, 201);
});

const starterSchema = z.object({ business: z.string().trim().min(1).max(200) });

/** Time inicial a partir da área de atuação (marketing, comércio, tecnologia, serviços ou genérico). Admin. Idempotente. */
miscRoutes.post("/starter-team", async (c) => {
  assertAdmin(c, "Só admins montam o time inicial.");
  const { business } = await readBody(c, starterSchema);
  const result = await createStarterTeam(c.get("hub"), c.get("userId"), business);
  return c.json(result, result.createdAgents > 0 || result.createdChannels > 0 ? 201 : 200);
});
