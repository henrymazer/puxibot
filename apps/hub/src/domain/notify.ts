import type { NotificationDTO } from "@puxibot/shared";
import { newId, run } from "../lib/db";
import type { HubCtx } from "./context";
import { toNotificationDTO, type NotificationRow } from "./rows";

export interface NotifyInput {
  userId: string;
  kind: NotificationDTO["kind"];
  title: string;
  body?: string | null;
  /** Caminho na interface web, ex.: "/w/<ws>/c/<canal>". */
  link?: string | null;
}

/** Canais extras de entrega (Web Push, Telegram...). A segunda leva registra os seus aqui. */
export type NotificationDelivery = (ctx: HubCtx, userId: string, notification: NotificationDTO) => Promise<void>;
const deliveries: NotificationDelivery[] = [];

export function registerNotificationDelivery(delivery: NotificationDelivery): void {
  deliveries.push(delivery);
}

/**
 * Ponto único de criação de notificações: grava na tabela, emite `notification.created`
 * para a pessoa e chama os canais extras registrados. Falha de canal extra não derruba a notificação.
 */
export async function notify(ctx: HubCtx, input: NotifyInput): Promise<NotificationDTO> {
  const row: NotificationRow = {
    id: newId(),
    workspace_id: ctx.wsId,
    user_id: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
    read_at: null,
    created_at: Date.now(),
  };
  await run(
    ctx.env.DB,
    `INSERT INTO notifications (id, workspace_id, user_id, kind, title, body, link, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    row.id,
    row.workspace_id,
    row.user_id,
    row.kind,
    row.title,
    row.body,
    row.link,
    row.created_at,
  );
  const notification = toNotificationDTO(row);
  await ctx.rt.publish({ type: "notification.created", notification }, [input.userId]);
  for (const deliver of deliveries) {
    try {
      await deliver(ctx, input.userId, notification);
    } catch (err) {
      console.error(JSON.stringify({ msg: "notification delivery failed", error: String(err) }));
    }
  }
  return notification;
}

/** Links da interface web (rotas do apps/web). */
export const links = {
  channel: (wsId: string, channelId: string) => `/w/${wsId}/c/${channelId}`,
  agent: (wsId: string, agentId: string) => `/w/${wsId}/equipe?agente=${encodeURIComponent(agentId)}`,
  approvals: (wsId: string) => `/w/${wsId}/aprovacoes`,
  tasks: (wsId: string, taskNumber?: number) => `/w/${wsId}/tarefas${taskNumber ? `?tarefa=${taskNumber}` : ""}`,
  wiki: (wsId: string, pageId: string) => `/w/${wsId}/wiki?pagina=${encodeURIComponent(pageId)}`,
  invite: (code: string) => `/convite/${code}`,
  pair: (code: string) => `/parear?code=${encodeURIComponent(code)}`,
};
