import { bool, first } from "../lib/db";
import { isChannelMember, isOpenChannel } from "./channels";
import type { ChannelRow } from "./rows";

/**
 * Agentes nunca enxergam canais `humansOnly`, nem canais privados/DMs de que não são membros.
 * Vale para todo agente, inclusive o assistente pessoal.
 */
export async function agentCanSeeChannel(db: D1Database, ch: ChannelRow, agentId: string): Promise<boolean> {
  if (bool(ch.humans_only)) return false;
  if (isOpenChannel(ch)) return true;
  return isChannelMember(db, ch.id, { type: "agent", id: agentId });
}

/**
 * Canal visível a um agente agindo por uma pessoa (`principalUserId`): o agente precisa enxergá-lo e a pessoa
 * também (canal aberto, ou ela é membro). Assim um pedido de Yara não lê a DM de Xavier com o mesmo agente.
 */
export async function agentCanSeeChannelFor(db: D1Database, ch: ChannelRow, agentId: string, principalUserId: string): Promise<boolean> {
  if (!(await agentCanSeeChannel(db, ch, agentId))) return false;
  if (isOpenChannel(ch)) return true;
  return isChannelMember(db, ch.id, { type: "user", id: principalUserId });
}

/** Canal por id ou por nome (com ou sem #). */
export async function findChannelByRef(db: D1Database, wsId: string, ref: string): Promise<ChannelRow | null> {
  const clean = ref.trim();
  const byId = await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND id = ?", wsId, clean);
  if (byId) return byId;
  const name = clean.replace(/^#/, "").toLowerCase();
  return first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name = ?", wsId, name);
}
