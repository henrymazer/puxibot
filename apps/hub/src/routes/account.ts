import { Hono } from "hono";
import { z } from "zod";
import { pushSubscriptionSchema, type MyNotificationDTO, type TelegramLinkDTO } from "@puxibot/shared";
import { all, first, newId, run } from "../lib/db";
import { badRequest, HttpError, notFound } from "../lib/errors";
import { randomCode, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { intParam, readBody, readTextLimited } from "../lib/validate";
import { handleInbound, linkCodeFrom, sendChatText, verifyWhatsAppSignature, whatsappConfigured, whatsappTexts, type WhatsAppWebhook } from "../domain/chatChannels";
import { authUserId, requireUser } from "../http/auth";
import type { BaseEnv } from "../http/types";
import { publicUrl } from "../env";
import { finishOAuth } from "../domain/connectorOauth";
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
  message?: { chat?: { id?: number | string; type?: string }; text?: string };
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
  // Só conversa privada com o bot: num grupo, qualquer participante falaria com o agente da pessoa.
  const privateChat = update.message?.chat?.type === undefined || update.message.chat.type === "private";
  let reply: string | null;
  // Conversa com um agente: código de vínculo de conversa, ou mensagem de uma conta já vinculada.
  const chatLinked = privateChat && (await first(c.env.DB, "SELECT 1 AS one FROM chat_links WHERE provider = 'telegram' AND external_id = ?", String(chatId)));
  const chatCode = privateChat && m && (await first(c.env.DB, "SELECT 1 AS one FROM chat_links WHERE provider = 'telegram' AND external_id IS NULL AND link_code = ?", linkCodeFrom(text) ?? ""));
  if (chatCode || (chatLinked && !m)) {
    try {
      reply = await handleInbound(c.env, "telegram", String(chatId), text);
    } catch (err) {
      console.error(JSON.stringify({ msg: "telegram inbound failed", error: String(err) }));
      reply = "Não consegui passar sua mensagem ao agente agora. Tente de novo em instantes.";
    }
  } else if (m) {
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
  if (reply === null) return c.json({ ok: true });
  try {
    const res = await telegramApi(c.env, "sendMessage", { chat_id: chatId, text: reply });
    await res.body?.cancel();
  } catch (err) {
    console.warn(JSON.stringify({ msg: "telegram reply failed", error: String(err) }));
  }
  return c.json({ ok: true });
});

// ---------- WhatsApp (Cloud API) ----------
/** Registro do webhook: a Meta manda o texto que você configurou e espera o desafio de volta. */
accountRoutes.get("/whatsapp/webhook", async (c) => {
  const expected = c.env.WHATSAPP_VERIFY_TOKEN?.trim();
  const given = c.req.query("hub.verify_token") ?? "";
  if (!whatsappConfigured(c.env) || !expected || c.req.query("hub.mode") !== "subscribe" || !(await timingSafeEqual(given, expected))) {
    throw notFound("Rota não encontrada.");
  }
  return c.text(c.req.query("hub.challenge") ?? "", 200);
});

/** Mensagens recebidas. Só vale com a assinatura do app; responde 200 rápido para a Meta não reenviar. */
accountRoutes.post("/whatsapp/webhook", async (c) => {
  if (!whatsappConfigured(c.env)) throw notFound("Rota não encontrada.");
  const raw = await readTextLimited(c, 256 * 1024);
  if (!(await verifyWhatsAppSignature(c.env.WHATSAPP_APP_SECRET!.trim(), raw, c.req.header("X-Hub-Signature-256")))) {
    throw notFound("Rota não encontrada.");
  }
  let payload: WhatsAppWebhook = {};
  try {
    payload = JSON.parse(raw) as WhatsAppWebhook;
  } catch {
    return c.json({ ok: true });
  }
  for (const msg of whatsappTexts(payload, c.env.WHATSAPP_PHONE_NUMBER_ID!.trim()).slice(0, 10)) {
    try {
      const reply = await handleInbound(c.env, "whatsapp", msg.from, msg.text);
      if (reply) await sendChatText(c.env, "whatsapp", msg.from, reply);
    } catch (err) {
      console.error(JSON.stringify({ msg: "whatsapp inbound failed", error: String(err) }));
    }
  }
  return c.json({ ok: true });
});

// ---------- Retorno do login OAuth de um conector ----------
/**
 * O serviço manda o navegador de volta para cá com `code` e `state`. Só quem começou o login (mesma sessão)
 * consegue terminá-lo. Sempre responde com um redirecionamento para a tela de conectores, que mostra o
 * resultado; o código e o estado nunca seguem para a interface.
 */
accountRoutes.get("/oauth/callback", async (c) => {
  const origin = publicUrl(c.env, new URL(c.req.url).origin);
  const back = (wsId: string | null, params: Record<string, string>) => {
    const target = new URL(wsId ? `/w/${wsId}/config/conectores` : "/", origin);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return c.redirect(target.toString(), 302);
  };
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const auth = c.get("auth");
  if (!auth || auth.kind !== "session") return back(null, { oauth: "erro", motivo: "Entre no Puxibot neste navegador e comece o login do conector de novo." });
  // O workspace do fluxo, para voltar à tela certa mesmo quando o serviço devolve erro.
  const flow = state ? await first<{ workspace_id: string; connector_id: string; user_id: string }>(c.env.DB, "SELECT workspace_id, connector_id, user_id FROM oauth_flows WHERE state_hash = ?", await sha256Hex(state)) : null;
  const wsId = flow && flow.user_id === auth.userId ? flow.workspace_id : null;
  const providerError = c.req.query("error");
  if (providerError || !code || !state) {
    if (flow && wsId) await run(c.env.DB, "DELETE FROM oauth_flows WHERE state_hash = ?", await sha256Hex(state));
    const reason = providerError === "access_denied" ? "Você cancelou o login no serviço." : `O serviço devolveu um erro${providerError ? ` (${providerError.slice(0, 60)})` : ""}.`;
    return back(wsId, { oauth: "erro", motivo: reason });
  }
  try {
    const done = await finishOAuth(c.env, state, code, auth.userId);
    return back(done.workspaceId, { oauth: "ok", conector: done.connectorId });
  } catch (err) {
    const reason = err instanceof HttpError ? err.message : "Não foi possível concluir o login.";
    return back(wsId, { oauth: "erro", motivo: reason.slice(0, 300) });
  }
});
