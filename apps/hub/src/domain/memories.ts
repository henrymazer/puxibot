import type { MemoryDTO } from "@puxibot/shared";
import { all, first, newId, run, type SqlValue } from "../lib/db";
import { notFound } from "../lib/errors";
import { likePattern, type Actor } from "./actor";
import { toMemoryDTO, type MemoryRow } from "./rows";

export async function getMemory(db: D1Database, wsId: string, id: string): Promise<MemoryRow | null> {
  return first<MemoryRow>(db, "SELECT * FROM memories WHERE workspace_id = ? AND id = ?", wsId, id);
}

export async function listMemories(
  db: D1Database,
  wsId: string,
  f: { scope?: "agent" | "team"; agentId?: string | null; q?: string; limit?: number; includeTeamWithAgent?: boolean },
): Promise<MemoryDTO[]> {
  let sql = "SELECT * FROM memories WHERE workspace_id = ?";
  const params: SqlValue[] = [wsId];
  if (f.includeTeamWithAgent && f.agentId) {
    // Visão do agente: as próprias + as do time.
    if (f.scope === "agent") {
      sql += " AND scope = 'agent' AND agent_id = ?";
      params.push(f.agentId);
    } else if (f.scope === "team") sql += " AND scope = 'team'";
    else {
      sql += " AND (scope = 'team' OR (scope = 'agent' AND agent_id = ?))";
      params.push(f.agentId);
    }
  } else if (f.scope === "team") sql += " AND scope = 'team'";
  else if (f.scope === "agent") {
    sql += " AND scope = 'agent' AND agent_id = ?";
    params.push(f.agentId ?? "");
  }
  if (f.q) {
    sql += " AND content LIKE ? ESCAPE '\\'";
    params.push(likePattern(f.q));
  }
  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(Math.min(Math.max(f.limit ?? 200, 1), 500));
  return (await all<MemoryRow>(db, sql, ...params)).map(toMemoryDTO);
}

export async function createMemory(
  db: D1Database,
  wsId: string,
  actor: Actor,
  input: { scope: "agent" | "team"; agentId: string | null; content: string; source: MemoryDTO["source"] },
): Promise<MemoryDTO> {
  const now = Date.now();
  const row: MemoryRow = {
    id: newId(),
    workspace_id: wsId,
    scope: input.scope,
    agent_id: input.scope === "agent" ? input.agentId : null,
    content: input.content,
    source: input.source,
    created_by_type: actor.ref.type,
    created_by_id: actor.ref.id,
    created_at: now,
    updated_at: now,
    on_behalf_of_user_id: actor.onBehalfOfUserId,
  };
  await run(
    db,
    `INSERT INTO memories (id, workspace_id, scope, agent_id, content, source, created_by_type, created_by_id, created_at, updated_at, on_behalf_of_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.workspace_id,
    row.scope,
    row.agent_id,
    row.content,
    row.source,
    row.created_by_type,
    row.created_by_id,
    row.created_at,
    row.updated_at,
    row.on_behalf_of_user_id,
  );
  return toMemoryDTO(row);
}

export async function updateMemory(db: D1Database, wsId: string, row: MemoryRow, content: string): Promise<MemoryDTO> {
  const now = Date.now();
  await run(db, "UPDATE memories SET content = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", content, now, wsId, row.id);
  return toMemoryDTO({ ...row, content, updated_at: now });
}

export async function deleteMemory(db: D1Database, wsId: string, id: string): Promise<void> {
  const changed = await run(db, "DELETE FROM memories WHERE workspace_id = ? AND id = ?", wsId, id);
  if (changed === 0) throw notFound("Memória não encontrada.");
}
