import { quoteAppearsIn, type MemoryDTO } from "@puxibot/shared";
import { all, first, newId, run, type SqlValue } from "../lib/db";
import { notFound } from "../lib/errors";
import { likePattern, type Actor } from "./actor";
import { toMemoryDTO, type JobRow, type MemoryRow } from "./rows";

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
  input: {
    scope: "agent" | "team";
    agentId: string | null;
    content: string;
    source: MemoryDTO["source"];
    /** Padrão: "confirmed". Agente sem citação conferida grava "tentative". */
    status?: "confirmed" | "tentative";
    quote?: string | null;
    sourceMessageId?: string | null;
  },
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
    status: input.status ?? "confirmed",
    quote: input.quote ?? null,
    source_message_id: input.sourceMessageId ?? null,
  };
  await run(
    db,
    `INSERT INTO memories (id, workspace_id, scope, agent_id, content, source, created_by_type, created_by_id, created_at, updated_at, on_behalf_of_user_id,
       status, quote, source_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    row.status ?? "confirmed",
    row.quote ?? null,
    row.source_message_id ?? null,
  );
  return toMemoryDTO(row);
}

/** Edição feita por uma pessoa: o texto passa a ser dela, então a memória fica confirmada. */
export async function updateMemory(db: D1Database, wsId: string, row: MemoryRow, content: string): Promise<MemoryDTO> {
  const now = Date.now();
  await run(db, "UPDATE memories SET content = ?, status = 'confirmed', updated_at = ? WHERE workspace_id = ? AND id = ?", content, now, wsId, row.id);
  return toMemoryDTO({ ...row, content, status: "confirmed", updated_at: now });
}

/**
 * O que pessoas escreveram e que origina este trabalho: o pedido (quando veio de uma pessoa) e as mensagens
 * de pessoas na mesma conversa. Só daqui pode sair a citação que sustenta uma memória — nunca da resposta
 * do agente, de um resultado de ferramenta ou de uma página (desenho do Nod: "memory ignores outside content").
 */
export async function humanWords(
  db: D1Database,
  wsId: string,
  job: Pick<JobRow, "origin" | "prompt" | "requested_by_user_id" | "channel_id" | "thread_root_id" | "trigger_message_id" | "created_at">,
): Promise<{ text: string; messageId: string | null }[]> {
  const out: { text: string; messageId: string | null }[] = [];
  if (job.origin === "user" && job.requested_by_user_id) out.push({ text: job.prompt, messageId: job.trigger_message_id });
  if (job.channel_id) {
    const rows = await all<{ id: string; body: string }>(
      db,
      job.thread_root_id
        ? `SELECT id, body FROM messages WHERE workspace_id = ? AND channel_id = ? AND author_type = 'user' AND deleted_at IS NULL
             AND (id = ? OR thread_root_id = ?) ORDER BY created_at DESC LIMIT 30`
        : `SELECT id, body FROM messages WHERE workspace_id = ? AND channel_id = ? AND author_type = 'user' AND deleted_at IS NULL
             AND thread_root_id IS NULL ORDER BY created_at DESC LIMIT 30`,
      ...(job.thread_root_id ? [wsId, job.channel_id, job.thread_root_id, job.thread_root_id] : [wsId, job.channel_id]),
    );
    for (const r of rows) out.push({ text: r.body, messageId: r.id });
  }
  return out;
}

/** Procura a citação nas palavras das pessoas. Devolve a mensagem de onde ela veio, ou `null` se não existe. */
export function findQuote(quote: string | null | undefined, words: { text: string; messageId: string | null }[]): { messageId: string | null } | null {
  if (!quote) return null;
  const hit = words.find((w) => quoteAppearsIn(quote, [w.text]));
  return hit ? { messageId: hit.messageId } : null;
}

export async function confirmMemory(db: D1Database, wsId: string, row: MemoryRow): Promise<MemoryDTO> {
  const now = Date.now();
  await run(db, "UPDATE memories SET status = 'confirmed', updated_at = ? WHERE workspace_id = ? AND id = ?", now, wsId, row.id);
  return toMemoryDTO({ ...row, status: "confirmed", updated_at: now });
}

export async function deleteMemory(db: D1Database, wsId: string, id: string): Promise<void> {
  const changed = await run(db, "DELETE FROM memories WHERE workspace_id = ? AND id = ?", wsId, id);
  if (changed === 0) throw notFound("Memória não encontrada.");
}
