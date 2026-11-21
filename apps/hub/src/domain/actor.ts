import type { ActorRef } from "@puxibot/shared";
import { first } from "../lib/db";

/**
 * Quem está fazendo a ação nas funções de domínio da segunda leva (tarefas, wiki, drive, memórias...).
 * - pessoa (rotas /api/workspaces/:ws): `ref = user`, `requestedByUserId = ela mesma`;
 * - agente (API de ferramentas /api/tool): `ref = agent`, `onBehalfOfUserId`/`requestedByUserId` = quem pediu o job,
 *   `parentJobId` = o job em execução.
 */
export interface Actor {
  ref: ActorRef;
  /** "Tito, em nome de Renato": gravado em `on_behalf_of_user_id` quando um agente age por uma pessoa. */
  onBehalfOfUserId: string | null;
  /** Pessoa na origem da cadeia (vai em `requested_by_user_id` dos jobs que esta ação criar). */
  requestedByUserId: string | null;
  /** Job do agente que está agindo (vira `parent_job_id` dos jobs criados). */
  parentJobId: string | null;
  isAdmin: boolean;
  /**
   * Pessoa por quem o ator responde. Pessoa: ela mesma. Agente: quem pediu o job ou, sem pedido humano
   * (rotina, consulta autoiniciada), o responsável pelo agente. Um agente nunca enxerga nem aciona além do que
   * essa pessoa poderia (evita o "confused deputy": pedir a um agente que leia a DM de outra pessoa com ele).
   */
  principalUserId: string;
}

export function userActor(userId: string, isAdmin: boolean): Actor {
  return {
    ref: { type: "user", id: userId },
    onBehalfOfUserId: null,
    requestedByUserId: userId,
    parentJobId: null,
    isAdmin,
    principalUserId: userId,
  };
}

export function agentActor(
  agentId: string,
  job: { jobId: string; requestedByUserId: string | null; principalUserId: string },
): Actor {
  return {
    ref: { type: "agent", id: agentId },
    onBehalfOfUserId: job.requestedByUserId,
    requestedByUserId: job.requestedByUserId,
    parentJobId: job.jobId,
    isAdmin: false,
    principalUserId: job.principalUserId,
  };
}

/** Quem responde pelo job: quem pediu ou, sem pedido humano, o responsável pelo agente. */
export function jobPrincipal(job: { requested_by_user_id: string | null }, agent: { owner_user_id: string }): string {
  return job.requested_by_user_id ?? agent.owner_user_id;
}

/** Nome de exibição de um ator (pessoa ou agente), para títulos de notificação. */
export async function actorName(db: D1Database, wsId: string, ref: ActorRef): Promise<string> {
  if (ref.type === "user") {
    return (await first<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", ref.id))?.name ?? "Alguém";
  }
  return (await first<{ name: string }>(db, "SELECT name FROM agents WHERE workspace_id = ? AND id = ?", wsId, ref.id))?.name ?? "Um agente";
}

/** Escapa `%`, `_` e `\` para LIKE ... ESCAPE '\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
