import { Hono } from "hono";
import { z } from "zod";
import { ROLES } from "@puxibot/shared";
import { publicUrl } from "../env";
import { first, run } from "../lib/db";
import { forbidden, notFound } from "../lib/errors";
import { randomToken } from "../lib/crypto";
import { readBody } from "../lib/validate";
import { assertAdmin, authUserId, requireSession } from "../http/auth";
import type { BaseEnv, WsEnv } from "../http/types";
import { links } from "../domain/notify";
import { acceptInvite, inviteIsValid, type InviteRow } from "../domain/workspaces";

/** /api/invites/:code (público e aceite por sessão) */
export const inviteRoutes = new Hono<BaseEnv>();

inviteRoutes.get("/invites/:code", async (c) => {
  const invite = await first<InviteRow & { workspace_name: string }>(
    c.env.DB,
    "SELECT i.*, w.name AS workspace_name FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = ?",
    c.req.param("code"),
  );
  if (!invite) throw notFound("Convite não encontrado.");
  return c.json({ workspaceName: invite.workspace_name, valid: inviteIsValid(invite) });
});

inviteRoutes.post("/invites/:code/accept", requireSession, async (c) => {
  const workspace = await acceptInvite(c.env, c.req.param("code"), authUserId(c));
  return c.json({ workspace });
});

/** POST /api/workspaces/:ws/invites */
export const workspaceInviteRoutes = new Hono<WsEnv>();

const createInviteSchema = z.object({
  role: z.enum(ROLES).default("member"),
  maxUses: z.number().int().min(1).max(1000).default(1),
  expiresInDays: z.number().min(0.01).max(90).default(7),
});

workspaceInviteRoutes.post("/invites", async (c) => {
  assertAdmin(c, "Só admins podem convidar pessoas.");
  const body = await readBody(c, createInviteSchema);
  if (body.role === "owner") throw forbidden("Convites não podem dar papel de dono.");
  const code = randomToken("", 12);
  const now = Date.now();
  await run(
    c.env.DB,
    `INSERT INTO invites (id, workspace_id, role, created_by, created_at, expires_at, max_uses, uses)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    code,
    c.get("wsId"),
    body.role,
    c.get("userId"),
    now,
    now + Math.round(body.expiresInDays * 86_400_000),
    body.maxUses,
  );
  const base = publicUrl(c.env, new URL(c.req.url).origin);
  return c.json({ code, url: `${base}${links.invite(code)}` }, 201);
});
