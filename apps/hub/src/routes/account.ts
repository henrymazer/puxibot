import { Hono } from "hono";
import { z } from "zod";
import { pushSubscriptionSchema, type MyNotificationDTO, type TelegramLinkDTO } from "@puxibot/shared";
import { all, first, newId, run } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import { randomCode, timingSafeEqual } from "../lib/crypto";
import { intParam, readBody } from "../lib/validate";
import { authUserId, requireUser } from "../http/auth";
import type { BaseEnv } from "../http/types";
import { toNotificationDTO, type NotificationRow } from "../domain/rows";
import { MAX_PUSH_SUBSCRIPTIONS, pushEndpointProblem, vapidConfigured } from "../domain/push";
import { botUsername, telegramApi, telegramConfigured } from "../domain/telegram";

/** Rotas da conta fora de um workspace: /api/me/notifications, /api/push/*, /api/telegram/*. */
export const accountRoutes = new Hono<BaseEnv>();

/**
 * Notificações da pessoa em todos os workspaces de que é membro. O service worker chama ao receber um push
 * (que chega sem conteúdo) para montar o aviso.
 */
accountRoutes.get("/me/notifications", requireUser(), async (c) => {
  const userId = authUserId(c);
  const auth = c.get("auth");
  // Token pessoal vale para um workspace só: não lista notificações dos outros.
  const onlyWs = auth?.kind === "token" ? auth.workspaceId : null;
  const unreadOnly = c.req.query("unread") === "1" || c.req.query("unread") === "true";
  const rows = await all<NotificationRow>(
    c.env.DB,
    `SELECT n.* FROM notifications n JOIN members m ON m.workspace_id = n.workspace_id AND m.user_id = n.user_id
     WHERE n.user_id = ? ${unreadOnly ? "AND n.read_at IS NULL" : ""} ${onlyWs ? "AND n.workspace_id = ?" : ""}
     ORDER BY n.created_at DESC LIMIT ?`,
    userId,
    ...(onlyWs ? [onlyWs] : []),
    intParam(c.req.query("limit"), 20, 1, 100),
  );
  const items: MyNotificationDTO[] = rows.map((r) => ({ ...toNotificationDTO(r), workspaceId: r.workspace_id }));
  return c.json({ items });
});

// ---------- Web Push ----------
accountRoutes.get("/push/public-key", (c) => {
  if (!vapidConfigured(c.env)) throw notFound("Notificações push não estão configuradas neste hub.");
  return c.json({ key: c.env.VAPID_PUBLIC_KEY!.trim() });
});

accountRoutes.post("/push/subscriptions", requireUser(), async (c) => {
  if (!vapidConfigured(c.env)) throw notFound("Notificações push não estão configuradas neste hub.");
  const body = await readBody(c, pushSubscriptionSchema);
  const problem = pushEndpointProblem(body.endpoint);
  if (problem) throw badRequest(problem, "invalid_push_endpoint");
  const userId = authUserId(c);
  // Endpoint é único: se já existia (outra pessoa no mesmo navegador), passa a ser desta pessoa.
  await run(
    c.env.DB,
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    newId(),
    userId,
    body.endpoint,
    body.keys.p256dh,
    body.keys.auth,
    Date.now(),
  );
  // No máximo MAX_PUSH_SUBSCRIPTIONS por pessoa (cada notificação vira um POST para cada endpoint): ficam as mais novas.
  await run(
    c.env.DB,
    `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    userId,
    userId,
    MAX_PUSH_SUBSCRIPTIONS,
  );
  return c.json({ ok: true }, 201);
});

accountRoutes.delete("/push/subscriptions", requireUser(), async (c) => {
  const endpoint = c.req.query("endpoint") ?? (await readBody(c, z.object({ endpoint: z.string().min(1) }))).endpoint;
  await run(c.env.DB, "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?", authUserId(c), endpoint);
  return c.body(null, 204);
});

// ---------- Telegram ----------
interface TelegramLinkRow {
  user_id: string;
  chat_id: string | null;
  link_code: string;
  enabled: number;
  created_at: number;
}

function newLinkCode(): string {
  return randomCode(3, 4).replace(/-/g, "");
}

async function linkDTO(env: BaseEnv["Bindings"], row: TelegramLinkRow): Promise<TelegramLinkDTO> {
  return { botUsername: await botUsername(env), linkCode: row.link_code, linked: row.chat_id != null };
}

async function ensureLink(db: D1Database, userId: string, regenerate: boolean): Promise<TelegramLinkRow> {
  const existing = await first<TelegramLinkRow>(db, "SELECT * FROM telegram_links WHERE user_id = ?", userId);
  if (existing && !regenerate) return existing;
  const code = newLinkCode();
  if (existing) {
    await run(db, "UPDATE telegram_links SET link_code = ? WHERE user_id = ?", code, userId);
    return { ...existing, link_code: code };
  }
  const row: TelegramLinkRow = { user_id: userId, chat_id: null, link_code: code, enabled: 1, created_at: Date.now() };
  await run(db, "INSERT INTO telegram_links (user_id, chat_id, link_code, enabled, created_at) VALUES (?, NULL, ?, 1, ?)", userId, code, row.created_at);
  return row;
}

function assertTelegram(env: BaseEnv["Bindings"]) {
  if (!telegramConfigured(env)) throw notFound("O Telegram não está configurado neste hub.");
}

/** `{ botUsername, linkCode, linked }`. A pessoa manda `/start <linkCode>` ao bot (ou abre t.me/<bot>?start=<linkCode>). */
accountRoutes.get("/telegram/link", requireUser(), async (c) => {
  assertTelegram(c.env);
  return c.json(await linkDTO(c.env, await ensureLink(c.env.DB, authUserId(c), false)));
});

/** Gera um código novo (o antigo deixa de valer). A conta já vinculada continua vinculada. */
accountRoutes.post("/telegram/link", requireUser(), async (c) => {
  assertTelegram(c.env);
  return c.json(await linkDTO(c.env, await ensureLink(c.env.DB, authUserId(c), true)));
});

accountRoutes.delete("/telegram/link", requireUser(), async (c) => {
  assertTelegram(c.env);
  await run(c.env.DB, "DELETE FROM telegram_links WHERE user_id = ?", authUserId(c));
  return c.body(null, 204);
});

interface TelegramUpdate {
  message?: { chat?: { id?: number | string }; text?: string };
}

/** Webhook do bot (configure com setWebhook para <PUBLIC_URL>/api/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>). */
accountRoutes.post("/telegram/webhook/:secret", async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!telegramConfigured(c.env) || !secret || !(await timingSafeEqual(c.req.param("secret"), secret))) {
    throw notFound("Rota não encontrada.");
  }
  let update: TelegramUpdate = {};
  try {
    update = (await c.req.json()) as TelegramUpdate;
  } catch {
    return c.json({ ok: true });
  }
  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim() ?? "";
  const m = /^\/start(?:@\w+)?\s+([A-Za-z0-9-]{4,40})$/.exec(text);
  if (chatId == null) return c.json({ ok: true });
  let reply: string;
  if (m) {
    const code = m[1]!.toUpperCase().replace(/-/g, "");
    const changed = await run(c.env.DB, "UPDATE telegram_links SET chat_id = ?, enabled = 1 WHERE link_code = ?", String(chatId), code);
    reply = changed
      ? "Pronto! Você vai receber aqui os avisos do Puxibot (só o aviso e o link, nunca o conteúdo das mensagens)."
      : "Código não encontrado. Gere um novo em Configurações › Notificações e tente de novo.";
  } else if (text.startsWith("/stop")) {
    await run(c.env.DB, "UPDATE telegram_links SET enabled = 0 WHERE chat_id = ?", String(chatId));
    reply = "Avisos pausados. Para voltar, gere um novo código na interface do Puxibot.";
  } else {
    reply = "Para receber avisos, envie /start <código> com o código mostrado em Configurações › Notificações.";
  }
  try {
    const res = await telegramApi(c.env, "sendMessage", { chat_id: chatId, text: reply });
    await res.body?.cancel();
  } catch (err) {
    console.warn(JSON.stringify({ msg: "telegram reply failed", error: String(err) }));
  }
  return c.json({ ok: true });
});
