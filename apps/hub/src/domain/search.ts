import type { ActorRef, SearchResultsDTO } from "@puxibot/shared";
import { all } from "../lib/db";
import { likePattern, type Actor } from "./actor";
import { listFiles } from "./files";
import { messagesToDTO } from "./messages";
import { toWikiPageDTO, type MessageRow, type WikiPageRow } from "./rows";
import { listTasks } from "./tasks";

const PER_KIND = 20;

/**
 * Condição SQL sobre `c` (channels) para os canais que o ator enxerga.
 * Pessoa: canal aberto ou membro. Agente: nunca canal só de humanos; canal aberto ou membro.
 */
export function visibleChannelSql(actor: ActorRef, principalUserId?: string): { sql: string; params: string[] } {
  const member = "EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_type = ? AND cm.member_id = ?)";
  if (actor.type === "user") return { sql: `((c.kind = 'channel' AND c.is_private = 0) OR ${member})`, params: ["user", actor.id] };
  // Agente agindo por uma pessoa: canal aberto, ou o agente E a pessoa são membros.
  if (principalUserId) {
    return {
      sql: `(c.humans_only = 0 AND ((c.kind = 'channel' AND c.is_private = 0) OR (${member} AND ${member})))`,
      params: ["agent", actor.id, "user", principalUserId],
    };
  }
  return { sql: `(c.humans_only = 0 AND ((c.kind = 'channel' AND c.is_private = 0) OR ${member}))`, params: ["agent", actor.id] };
}

export async function searchWorkspace(
  db: D1Database,
  wsId: string,
  actor: Actor,
  q: string,
  include: { messages: boolean; tasks: boolean; wiki: boolean; files: boolean } = { messages: true, tasks: true, wiki: true, files: true },
): Promise<SearchResultsDTO> {
  const term = q.trim().slice(0, 200);
  const empty: SearchResultsDTO = { messages: [], tasks: [], wikiPages: [], files: [] };
  if (!term) return empty;
  const pattern = likePattern(term);
  const vis = visibleChannelSql(actor.ref, actor.ref.type === "agent" ? actor.principalUserId : undefined);
  const [messages, tasks, wiki, files] = await Promise.all([
    include.messages
      ? all<MessageRow>(
          db,
          `SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
           WHERE m.workspace_id = ? AND m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\' AND ${vis.sql}
           ORDER BY m.created_at DESC LIMIT ?`,
          wsId,
          pattern,
          ...vis.params,
          PER_KIND,
        )
      : Promise.resolve([]),
    include.tasks ? listTasks(db, wsId, { q: term, limit: PER_KIND }) : Promise.resolve([]),
    include.wiki
      ? all<WikiPageRow>(
          db,
          `SELECT * FROM wiki_pages WHERE workspace_id = ? AND deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
           ORDER BY (title LIKE ? ESCAPE '\\') DESC, updated_at DESC LIMIT ?`,
          wsId,
          pattern,
          pattern,
          pattern,
          PER_KIND,
        )
      : Promise.resolve([]),
    include.files ? listFiles(db, wsId, actor, { q: term, limit: PER_KIND }) : Promise.resolve([]),
  ]);
  return {
    messages: await messagesToDTO(db, wsId, messages),
    tasks,
    wikiPages: wiki.map((w) => toWikiPageDTO(w, false)),
    files,
  };
}
