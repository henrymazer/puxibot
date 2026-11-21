/** Canais extras de notificação (Web Push sem conteúdo e Telegram só com aviso). Importado uma vez pelo app. */
import { registerNotificationDelivery } from "./notify";
import { deliverPush } from "./push";
import { deliverTelegram } from "./telegram";

let registered = false;

export function registerDeliveries(): void {
  if (registered) return;
  registered = true;
  registerNotificationDelivery((ctx, userId) => deliverPush(ctx, userId));
  registerNotificationDelivery((ctx, userId, notification) => deliverTelegram(ctx, userId, notification));
}
