/** Push, Telegram e notificações de todas as contas no modo demonstração. */
import { HttpError, type DemoContext } from "../backend";

export function registerNotify(ctx: DemoContext): void {
  const { db, on } = ctx;

  // Sem chave VAPID: neste "hub" de demonstração os avisos no aparelho ficam desligados.
  on("GET", "/push/public-key", () => {
    throw new HttpError(404, "push_disabled", "Web Push não está configurado neste hub.");
  });
  on("POST", "/push/subscriptions", () => ({ ok: true }), 201);
  on("DELETE", "/push/subscriptions", () => undefined);

  let linkedTimer: ReturnType<typeof setTimeout> | null = null;
  const newCode = () => {
    db.telegram.linkCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    // Simula a pessoa tocando em "Iniciar" no bot alguns segundos depois.
    if (linkedTimer) clearTimeout(linkedTimer);
    linkedTimer = setTimeout(() => {
      db.telegram.linked = true;
    }, 8000);
  };
  const view = () => ({ botUsername: "puxibot_demo_bot", linkCode: db.telegram.linkCode ?? "", linked: db.telegram.linked });
  on("GET", "/telegram/link", () => {
    if (!db.telegram.linked && !db.telegram.linkCode) newCode();
    return view();
  });
  on("POST", "/telegram/link", () => {
    db.telegram.linked = false;
    newCode();
    return view();
  });
  on("DELETE", "/telegram/link", () => {
    if (linkedTimer) clearTimeout(linkedTimer);
    db.telegram.linked = false;
    db.telegram.linkCode = null;
  });

  on("GET", "/me/notifications", () => ({
    items: db.notifications.map((n) => ({ ...n, workspaceId: db.workspaces[0]!.id })),
  }));
}
