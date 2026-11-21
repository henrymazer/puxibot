import type { Context } from "hono";
import { HttpError } from "./errors";

/**
 * Limite de tentativas com janela fixa no D1 (sem depender de produto de rate limit da Cloudflare).
 * Um único UPSERT atômico incrementa o contador (ou reinicia a janela vencida) e devolve o valor.
 */
export async function hit(db: D1Database, key: string, windowMs: number, now = Date.now()): Promise<{ count: number; resetAt: number }> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
       RETURNING count, window_start`,
    )
    .bind(key, now, now - windowMs, now - windowMs)
    .first<{ count: number; window_start: number }>();
  return { count: row?.count ?? 1, resetAt: (row?.window_start ?? now) + windowMs };
}

export async function clear(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
}

/** Conta uma tentativa e lança 429 (com `Retry-After`) se passou do limite. */
export async function enforce(
  c: Context,
  key: string,
  limit: number,
  windowMs: number,
  message = "Muitas tentativas. Espere alguns minutos e tente de novo.",
): Promise<void> {
  const { count, resetAt } = await hit(c.env.DB as D1Database, key, windowMs);
  if (count > limit) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
    throw new HttpError(429, "rate_limited", message);
  }
}

/**
 * IP do cliente (`CF-Connecting-IP`, sempre presente atrás da Cloudflare). Sem ele (testes, `wrangler dev`
 * sem proxy) devolve null e os limites por IP não se aplicam; os limites por conta (e-mail, pessoa) continuam.
 */
export function clientIp(c: Context): string | null {
  const ip = c.req.header("CF-Connecting-IP")?.trim();
  return ip ? ip.slice(0, 64) : null;
}

/** Apaga janelas antigas (chamado pelo cron do Worker). */
export async function pruneRateLimits(db: D1Database, olderThanMs = 24 * 60 * 60_000): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Date.now() - olderThanMs).run();
}
