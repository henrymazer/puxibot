import { Hono } from "hono";
import { z } from "zod";
import { all, placeholders, run } from "../lib/db";
import { readBody } from "../lib/validate";
import type { WsEnv } from "../http/types";
import { toNotificationDTO, type NotificationRow } from "../domain/rows";

/** /api/workspaces/:ws/notifications */
export const notificationRoutes = new Hono<WsEnv>();

notificationRoutes.get("/notifications", async (c) => {
  const rows = await all<NotificationRow>(
    c.env.DB,
    "SELECT * FROM notifications WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100",
    c.get("wsId"),
    c.get("userId"),
  );
  return c.json({ items: rows.map(toNotificationDTO) });
});

const readSchema = z.object({ ids: z.array(z.string()).max(500).optional() });

notificationRoutes.post("/notifications/read", async (c) => {
  const { ids } = await readBody(c, readSchema);
  const now = Date.now();
  if (ids && ids.length > 0) {
    await run(
      c.env.DB,
      `UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL
         AND id IN (${placeholders(ids.length)})`,
      now,
      c.get("wsId"),
      c.get("userId"),
      ...ids,
    );
  } else {
    await run(
      c.env.DB,
      "UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL",
      now,
      c.get("wsId"),
      c.get("userId"),
    );
  }
  return c.body(null, 204);
});
