/**
 * Telegram, só avisos: o texto enviado é o título genérico da notificação ("Marcos respondeu em #dev") e o link.
 * Nunca o corpo da notificação nem conteúdo de mensagem. Sem TELEGRAM_BOT_TOKEN, o recurso fica desligado.
 */
import { publicUrl, type AppEnv } from "../env";
import { all } from "../lib/db";
import type { HubCtx } from "./context";
import type { NotificationDTO } from "@puxibot/shared";

export function telegramConfigured(env: AppEnv): boolean {
  return !!env.TELEGRAM_BOT_TOKEN?.trim();
}

export async function telegramApi(env: AppEnv, method: string, body: unknown): Promise<Response> {
  const token = env.TELEGRAM_BOT_TOKEN!.trim();
  try {
    return await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    // O token do bot vai na URL: nunca deixa ele chegar aos logs pela mensagem de erro.
    throw new Error(String(err).split(token).join("<token>"));
  }
}

let cachedUsername: { token: string; username: string } | null = null;

/** Usuário do bot: TELEGRAM_BOT_USERNAME, ou `getMe` (guardado em memória). */
export async function botUsername(env: AppEnv): Promise<string> {
  const configured = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (configured) return configured;
  const token = env.TELEGRAM_BOT_TOKEN!.trim();
  if (cachedUsername?.token === token) return cachedUsername.username;
  try {
    const res = await telegramApi(env, "getMe", {});
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    const username = data.result?.username ?? "";
    if (username) cachedUsername = { token, username };
    return username;
  } catch {
    return "";
  }
}

/** Texto do aviso: só o título e o link absoluto (se PUBLIC_URL estiver configurada). */
export function telegramText(env: AppEnv, n: Pick<NotificationDTO, "title" | "link">): string {
  const base = publicUrl(env);
  const link = n.link && base ? `${base}${n.link}` : null;
  return link ? `${n.title}\n${link}` : n.title;
}

export async function deliverTelegram(ctx: HubCtx, userId: string, n: NotificationDTO): Promise<void> {
  if (!telegramConfigured(ctx.env)) return;
  const links = await all<{ chat_id: string }>(
    ctx.env.DB,
    "SELECT chat_id FROM telegram_links WHERE user_id = ? AND enabled = 1 AND chat_id IS NOT NULL",
    userId,
  );
  for (const l of links) {
    const res = await telegramApi(ctx.env, "sendMessage", { chat_id: l.chat_id, text: telegramText(ctx.env, n), disable_web_page_preview: true });
    await res.body?.cancel();
  }
}
