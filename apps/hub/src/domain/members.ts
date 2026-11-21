import type { Role } from "@puxibot/shared";
import { all, first, run } from "../lib/db";
import type { HubCtx } from "./context";
import type { MemberRow, MemberWithUserRow } from "./rows";
import { createPersonalAssistant } from "./agents";

export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

export function isAdminRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export async function getMember(db: D1Database, wsId: string, userId: string): Promise<MemberRow | null> {
  return first<MemberRow>(db, "SELECT * FROM members WHERE workspace_id = ? AND user_id = ?", wsId, userId);
}

export async function listMembersWithUsers(db: D1Database, wsId: string): Promise<MemberWithUserRow[]> {
  return all<MemberWithUserRow>(
    db,
    `SELECT m.*, u.name, u.email, u.avatar_color FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY u.name COLLATE NOCASE`,
    wsId,
  );
}

export async function adminUserIds(db: D1Database, wsId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    db,
    "SELECT user_id FROM members WHERE workspace_id = ? AND role IN ('owner','admin')",
    wsId,
  );
  return rows.map((r) => r.user_id);
}

/**
 * Coloca a pessoa no workspace: linha em `members`, entrada no canal `general`
 * e criação do assistente pessoal (com DM e rotina `daily_summary`). Idempotente.
 */
export async function addMember(ctx: HubCtx, userId: string, role: Role): Promise<void> {
  const db = ctx.env.DB;
  const now = Date.now();
  const inserted = await run(
    db,
    `INSERT OR IGNORE INTO members (workspace_id, user_id, role, title, status_text, joined_at)
     VALUES (?, ?, ?, NULL, NULL, ?)`,
    ctx.wsId,
    userId,
    role,
    now,
  );
  if (inserted === 0) return;
  const general = await first<{ id: string }>(
    db,
    "SELECT id FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name = 'general'",
    ctx.wsId,
  );
  if (general) {
    await run(
      db,
      `INSERT OR IGNORE INTO channel_members (channel_id, member_type, member_id, last_read_at, joined_at)
       VALUES (?, 'user', ?, ?, ?)`,
      general.id,
      userId,
      now,
      now,
    );
  }
  await createPersonalAssistant(ctx, userId);
}
