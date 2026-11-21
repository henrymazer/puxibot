import type { Role, WorkspaceDTO } from "@puxibot/shared";
import type { AppEnv } from "../env";
import { all, first, newId, run, stmt } from "../lib/db";
import { HttpError, notFound } from "../lib/errors";
import { workerCtx } from "./context";
import { addMember, getMember } from "./members";
import { toWorkspaceDTO, type WorkspaceRow } from "./rows";

export async function getWorkspaceRow(db: D1Database, wsId: string): Promise<WorkspaceRow | null> {
  return first<WorkspaceRow>(db, "SELECT * FROM workspaces WHERE id = ?", wsId);
}

export async function workspaceDTO(db: D1Database, wsId: string, role: Role): Promise<WorkspaceDTO> {
  const row = await getWorkspaceRow(db, wsId);
  if (!row) throw notFound("Workspace não encontrado.");
  return toWorkspaceDTO(row, role);
}

export async function listUserWorkspaces(db: D1Database, userId: string): Promise<WorkspaceDTO[]> {
  const rows = await all<WorkspaceRow & { member_role: Role }>(
    db,
    `SELECT w.*, m.role AS member_role FROM workspaces w JOIN members m ON m.workspace_id = w.id
     WHERE m.user_id = ? ORDER BY m.joined_at`,
    userId,
  );
  return rows.map((r) => toWorkspaceDTO(r, r.member_role));
}

/** Cria o workspace com o criador como owner, o canal `general` e o assistente pessoal. */
export async function createWorkspace(
  env: AppEnv,
  userId: string,
  input: { name: string; kind: "personal" | "team"; business?: string | undefined },
): Promise<WorkspaceDTO> {
  const db = env.DB;
  const id = newId();
  const now = Date.now();
  const generalId = newId();
  await db.batch([
    stmt(
      db,
      `INSERT INTO workspaces (id, name, kind, business, router_enabled, task_seq, created_by, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      id,
      input.name,
      input.kind,
      input.business ?? null,
      userId,
      now,
    ),
    stmt(
      db,
      `INSERT INTO channels (id, workspace_id, kind, name, section, topic, humans_only, is_private, dm_key, created_by, created_at, last_message_at)
       VALUES (?, ?, 'channel', 'general', NULL, 'Conversa geral do time', 0, 0, NULL, ?, ?, NULL)`,
      generalId,
      id,
      userId,
      now,
    ),
  ]);
  await addMember(workerCtx(env, id), userId, "owner");
  return workspaceDTO(db, id, "owner");
}

export interface InviteRow {
  id: string;
  workspace_id: string;
  role: Role;
  created_by: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
}

export function inviteIsValid(inv: InviteRow, now = Date.now()): boolean {
  return inv.expires_at > now && inv.uses < inv.max_uses;
}

/**
 * Consome um uso do convite numa única instrução condicional (atômica no D1). Devolve o
 * convite, ou 410 se ele expirou ou já foi usado — inclusive quando dois pedidos disputam o
 * último uso ao mesmo tempo.
 */
export async function claimInvite(db: D1Database, code: string): Promise<InviteRow> {
  const claimed = await run(
    db,
    "UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND expires_at > ?",
    code,
    Date.now(),
  );
  if (claimed === 0) throw new HttpError(410, "invite_invalid", "Este convite expirou ou já foi usado.");
  const invite = await first<InviteRow>(db, "SELECT * FROM invites WHERE id = ?", code);
  if (!invite) throw new HttpError(410, "invite_invalid", "Este convite expirou ou já foi usado.");
  return invite;
}

/** Devolve o uso consumido por `claimInvite` (o cadastro falhou depois). */
export async function releaseInvite(db: D1Database, code: string): Promise<void> {
  await run(db, "UPDATE invites SET uses = uses - 1 WHERE id = ? AND uses > 0", code);
}

/** Entra no workspace de um convite já consumido. */
export async function joinClaimedInvite(env: AppEnv, invite: InviteRow, userId: string): Promise<WorkspaceDTO> {
  const role: Role = invite.role === "admin" ? "admin" : "member";
  await addMember(workerCtx(env, invite.workspace_id), userId, role);
  return workspaceDTO(env.DB, invite.workspace_id, role);
}

/** Usa o convite: entra no workspace (idempotente para quem já é membro). */
export async function acceptInvite(env: AppEnv, code: string, userId: string): Promise<WorkspaceDTO> {
  const db = env.DB;
  const invite = await first<InviteRow>(db, "SELECT * FROM invites WHERE id = ?", code);
  if (!invite) throw notFound("Convite não encontrado.");
  const existing = await getMember(db, invite.workspace_id, userId);
  if (existing) return workspaceDTO(db, invite.workspace_id, existing.role);
  return joinClaimedInvite(env, await claimInvite(db, code), userId);
}
