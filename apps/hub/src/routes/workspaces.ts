import { Hono, type Context } from "hono";
import { z } from "zod";
import { createWorkspaceSchema, ROLES, type BootstrapDTO, type MemberDTO } from "@puxibot/shared";
import { all, first, newId, placeholders, run } from "../lib/db";
import { badRequest, forbidden, HttpError, notFound } from "../lib/errors";
import { readBody } from "../lib/validate";
import { assertAdmin, authUserId, hasRole, isAdmin, requireUser } from "../http/auth";
import type { BaseEnv, WsEnv } from "../http/types";
import type { Presence } from "../domain/context";
import { listAgents } from "../domain/agents";
import { listVisibleChannels } from "../domain/channels";
import { listMembersWithUsers } from "../domain/members";
import {
  toApprovalDTO,
  toMemberDTO,
  toRunnerDTO,
  toSectorDTO,
  type ApprovalRow,
  type MemberRow,
  type MemberWithUserRow,
  type RunnerRow,
  type SectorRow,
} from "../domain/rows";
import { createWorkspace, workspaceDTO } from "../domain/workspaces";

/** POST /api/workspaces */
export const workspaceCreateRoutes = new Hono<BaseEnv>();

/** Workspaces que uma pessoa pode criar (cada um nasce com canal, assistente, rotina e alarme). */
export const MAX_WORKSPACES_PER_USER = 20;

workspaceCreateRoutes.post("/workspaces", requireUser(), async (c) => {
  const body = await readBody(c, createWorkspaceSchema);
  const userId = authUserId(c);
  const created = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM workspaces WHERE created_by = ?", userId);
  if ((created?.n ?? 0) >= MAX_WORKSPACES_PER_USER) {
    throw new HttpError(429, "workspace_limit", `Você já criou ${MAX_WORKSPACES_PER_USER} workspaces, o limite por pessoa.`);
  }
  const workspace = await createWorkspace(c.env, userId, body);
  return c.json(workspace, 201);
});

/** /api/workspaces/:ws, bootstrap, membros e setores */
export const workspaceRoutes = new Hono<WsEnv>();

function memberDTOs(rows: MemberWithUserRow[], presence: Presence): MemberDTO[] {
  const online = new Set(presence.onlineUserIds);
  const withRunner = new Set(presence.runners.map((r) => r.userId));
  return rows.map((r) => toMemberDTO(r, { online: online.has(r.user_id), runnerOnline: withRunner.has(r.user_id) }));
}

export async function listRunnerDTOs(db: D1Database, wsId: string, presence: Presence) {
  const rows = await all<RunnerRow>(db, "SELECT * FROM runners WHERE workspace_id = ? ORDER BY name", wsId);
  const online = new Set(presence.runners.map((r) => r.runnerId));
  return rows.map((r) => toRunnerDTO(r, online.has(r.id)));
}

/** Aprovações que a pessoa pode decidir (admin vê todas). */
export async function visibleApprovals(c: Context<WsEnv>, status: string | string[] | null) {
  const wsId = c.get("wsId");
  const params: (string | number)[] = [wsId];
  let sql = "SELECT * FROM approvals WHERE workspace_id = ?";
  if (!isAdmin(c)) {
    sql += " AND approver_user_id = ?";
    params.push(c.get("userId"));
  }
  const statuses = status == null ? [] : Array.isArray(status) ? status : [status];
  if (statuses.length) {
    sql += ` AND status IN (${placeholders(statuses.length)})`;
    params.push(...statuses);
  }
  sql += " ORDER BY created_at DESC LIMIT 200";
  const rows = await all<ApprovalRow>(c.env.DB, sql, ...params);
  return rows.map(toApprovalDTO);
}

workspaceRoutes.get("/", async (c) => {
  return c.json({ workspace: await workspaceDTO(c.env.DB, c.get("wsId"), c.get("member").role) });
});

const patchWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  business: z.string().max(200).nullable().optional(),
  routerEnabled: z.boolean().optional(),
});

workspaceRoutes.patch("/", async (c) => {
  assertAdmin(c);
  const body = await readBody(c, patchWorkspaceSchema);
  const wsId = c.get("wsId");
  if (body.name !== undefined) await run(c.env.DB, "UPDATE workspaces SET name = ? WHERE id = ?", body.name, wsId);
  if (body.business !== undefined) await run(c.env.DB, "UPDATE workspaces SET business = ? WHERE id = ?", body.business, wsId);
  if (body.routerEnabled !== undefined) {
    await run(c.env.DB, "UPDATE workspaces SET router_enabled = ? WHERE id = ?", body.routerEnabled ? 1 : 0, wsId);
  }
  return c.json({ workspace: await workspaceDTO(c.env.DB, wsId, c.get("member").role) });
});

workspaceRoutes.get("/bootstrap", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const userId = c.get("userId");
  const presence = await c.get("hub").rt.presence();
  const [workspace, memberRows, sectors, agents, channels, runners, pendingApprovals, unread] = await Promise.all([
    workspaceDTO(db, wsId, c.get("member").role),
    listMembersWithUsers(db, wsId),
    all<SectorRow>(db, "SELECT * FROM sectors WHERE workspace_id = ? ORDER BY name", wsId),
    listAgents(db, wsId),
    listVisibleChannels(db, wsId, userId),
    listRunnerDTOs(db, wsId, presence),
    visibleApprovals(c, "pending"),
    first<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL",
      wsId,
      userId,
    ),
  ]);
  const members = memberDTOs(memberRows, presence);
  const body: BootstrapDTO = {
    workspace,
    me: members.find((m) => m.userId === userId)!,
    members,
    sectors: sectors.map(toSectorDTO),
    agents,
    channels,
    runners,
    pendingApprovals,
    unreadNotifications: unread?.n ?? 0,
  };
  return c.json(body);
});

// ---------- Membros ----------
workspaceRoutes.get("/members", async (c) => {
  const presence = await c.get("hub").rt.presence();
  return c.json({ items: memberDTOs(await listMembersWithUsers(c.env.DB, c.get("wsId")), presence) });
});

const patchMemberSchema = z.object({
  sectorId: z.string().nullable().optional(),
  role: z.enum(ROLES).optional(),
  title: z.string().max(80).nullable().optional(),
  statusText: z.string().max(80).nullable().optional(),
});

async function ownerCount(db: D1Database, wsId: string): Promise<number> {
  const row = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner'", wsId);
  return row?.n ?? 0;
}

async function requireTargetMember(c: Context<WsEnv>, userId: string): Promise<MemberRow> {
  const row = await first<MemberRow>(
    c.env.DB,
    "SELECT * FROM members WHERE workspace_id = ? AND user_id = ?",
    c.get("wsId"),
    userId,
  );
  if (!row) throw notFound("Pessoa não encontrada neste workspace.");
  return row;
}

workspaceRoutes.patch("/members/:userId", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const targetId = c.req.param("userId");
  const body = await readBody(c, patchMemberSchema);
  const target = await requireTargetMember(c, targetId);
  const self = targetId === c.get("userId");
  if (body.statusText !== undefined) {
    if (!self) throw forbidden("Só a própria pessoa muda o status.");
    await run(db, "UPDATE members SET status_text = ? WHERE workspace_id = ? AND user_id = ?", body.statusText, wsId, targetId);
  }
  if (body.sectorId !== undefined) {
    assertAdmin(c, "Só admins mudam o setor das pessoas.");
    if (body.sectorId) {
      const sector = await first(db, "SELECT 1 AS one FROM sectors WHERE workspace_id = ? AND id = ?", wsId, body.sectorId);
      if (!sector) throw notFound("Setor não encontrado.");
    }
    await run(db, "UPDATE members SET sector_id = ? WHERE workspace_id = ? AND user_id = ?", body.sectorId, wsId, targetId);
  }
  if (body.title !== undefined) {
    assertAdmin(c, "Só admins mudam o cargo.");
    await run(db, "UPDATE members SET title = ? WHERE workspace_id = ? AND user_id = ?", body.title, wsId, targetId);
  }
  if (body.role !== undefined && body.role !== target.role) {
    assertAdmin(c, "Só admins mudam papéis.");
    if ((body.role === "owner" || target.role === "owner") && !hasRole(c, "owner")) {
      throw forbidden("Só donos podem dar ou tirar o papel de dono.");
    }
    if (target.role === "owner" && (await ownerCount(db, wsId)) <= 1) {
      throw badRequest("O workspace precisa de pelo menos um dono.", "last_owner");
    }
    // Condicional (atômico): dois donos se rebaixando ao mesmo tempo não deixam o workspace sem dono.
    const changed = await run(
      db,
      `UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?
         AND (role <> 'owner' OR ? = 'owner' OR (SELECT COUNT(*) FROM members WHERE workspace_id = ? AND role = 'owner') > 1)`,
      body.role,
      wsId,
      targetId,
      body.role,
      wsId,
    );
    if (changed === 0) throw badRequest("O workspace precisa de pelo menos um dono.", "last_owner");
  }
  const rows = await listMembersWithUsers(db, wsId);
  const presence = await c.get("hub").rt.presence();
  return c.json({ member: memberDTOs(rows, presence).find((m) => m.userId === targetId) });
});

workspaceRoutes.delete("/members/:userId", async (c) => {
  const db = c.env.DB;
  const wsId = c.get("wsId");
  const targetId = c.req.param("userId");
  const self = targetId === c.get("userId");
  if (!self) assertAdmin(c, "Só admins removem pessoas.");
  const target = await requireTargetMember(c, targetId);
  if (target.role === "owner" && (await ownerCount(db, wsId)) <= 1) {
    throw badRequest("O workspace precisa de pelo menos um dono.", "last_owner");
  }
  if (target.role === "owner" && !self && !hasRole(c, "owner")) throw forbidden("Só donos removem outro dono.");
  // Remove primeiro, de forma condicional (atômica), para nunca ficar sem dono; só então limpa o resto.
  const removed = await run(
    db,
    `DELETE FROM members WHERE workspace_id = ? AND user_id = ?
       AND (role <> 'owner' OR (SELECT COUNT(*) FROM members WHERE workspace_id = ? AND role = 'owner') > 1)`,
    wsId,
    targetId,
    wsId,
  );
  if (removed === 0) throw badRequest("O workspace precisa de pelo menos um dono.", "last_owner");
  await db.batch([
    db.prepare("DELETE FROM api_tokens WHERE workspace_id = ? AND user_id = ?").bind(wsId, targetId),
    db
      .prepare(
        `DELETE FROM channel_members WHERE member_type = 'user' AND member_id = ?
         AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)`,
      )
      .bind(targetId, wsId),
    db
      .prepare("UPDATE agents SET status = 'paused', updated_at = ? WHERE workspace_id = ? AND owner_user_id = ? AND is_assistant = 1")
      .bind(Date.now(), wsId, targetId),
  ]);
  await c.get("hub").rt.disconnectUser(targetId);
  return c.body(null, 204);
});

// ---------- Setores ----------
const sectorSchema = z.object({
  name: z.string().trim().min(1).max(60),
  leadUserId: z.string().nullable().optional(),
});

async function assertLead(c: Context<WsEnv>, leadUserId: string | null | undefined) {
  if (!leadUserId) return;
  await requireTargetMember(c, leadUserId);
}

workspaceRoutes.get("/sectors", async (c) => {
  const rows = await all<SectorRow>(c.env.DB, "SELECT * FROM sectors WHERE workspace_id = ? ORDER BY name", c.get("wsId"));
  return c.json({ items: rows.map(toSectorDTO) });
});

workspaceRoutes.post("/sectors", async (c) => {
  assertAdmin(c);
  const body = await readBody(c, sectorSchema);
  await assertLead(c, body.leadUserId);
  const row: SectorRow = { id: newId(), workspace_id: c.get("wsId"), name: body.name, lead_user_id: body.leadUserId ?? null };
  await run(
    c.env.DB,
    "INSERT INTO sectors (id, workspace_id, name, lead_user_id) VALUES (?, ?, ?, ?)",
    row.id,
    row.workspace_id,
    row.name,
    row.lead_user_id,
  );
  return c.json(toSectorDTO(row), 201);
});

workspaceRoutes.get("/sectors/:id", async (c) => {
  const row = await first<SectorRow>(
    c.env.DB,
    "SELECT * FROM sectors WHERE workspace_id = ? AND id = ?",
    c.get("wsId"),
    c.req.param("id"),
  );
  if (!row) throw notFound("Setor não encontrado.");
  return c.json(toSectorDTO(row));
});

workspaceRoutes.patch("/sectors/:id", async (c) => {
  assertAdmin(c);
  const body = await readBody(c, sectorSchema.partial());
  const wsId = c.get("wsId");
  const id = c.req.param("id");
  const row = await first<SectorRow>(c.env.DB, "SELECT * FROM sectors WHERE workspace_id = ? AND id = ?", wsId, id);
  if (!row) throw notFound("Setor não encontrado.");
  await assertLead(c, body.leadUserId);
  const next: SectorRow = {
    ...row,
    name: body.name ?? row.name,
    lead_user_id: body.leadUserId === undefined ? row.lead_user_id : body.leadUserId,
  };
  await run(
    c.env.DB,
    "UPDATE sectors SET name = ?, lead_user_id = ? WHERE workspace_id = ? AND id = ?",
    next.name,
    next.lead_user_id,
    wsId,
    id,
  );
  return c.json(toSectorDTO(next));
});

workspaceRoutes.delete("/sectors/:id", async (c) => {
  assertAdmin(c);
  const changed = await run(c.env.DB, "DELETE FROM sectors WHERE workspace_id = ? AND id = ?", c.get("wsId"), c.req.param("id"));
  if (changed === 0) throw notFound("Setor não encontrado.");
  return c.body(null, 204);
});
