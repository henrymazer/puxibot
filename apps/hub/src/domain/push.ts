/**
 * Web Push sem conteúdo (sem payload): o hub só "acorda" o service worker da interface, que então busca as
 * notificações na API (GET /api/me/notifications). Assim não precisamos cifrar payload (RFC 8291) e nenhum
 * conteúdo passa pelo serviço de push. Autenticação do servidor: VAPID (RFC 8292), JWT ES256 via WebCrypto.
 *
 * Chaves (geradas por `npm run vapid -w @puxibot/hub`):
 * - VAPID_PUBLIC_KEY: ponto P-256 não comprimido (65 bytes), base64url — o mesmo que vai no `applicationServerKey`;
 * - VAPID_PRIVATE_KEY: escalar privado (32 bytes), base64url;
 * - VAPID_SUBJECT: `mailto:...` ou `https://...` (opcional; padrão: PUBLIC_URL ou mailto genérico).
 * Sem as duas chaves, o recurso fica desligado sem erro.
 */
import type { AppEnv } from "../env";
import { all, run } from "../lib/db";
import { base64UrlToBytes, bytesToBase64Url } from "../lib/crypto";
import type { HubCtx } from "./context";

export function vapidConfigured(env: AppEnv): boolean {
  return !!(env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim());
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importVapidKey(publicKeyB64: string, privateKeyB64: string): Promise<CryptoKey> {
  const cacheKey = `${publicKeyB64}.${privateKeyB64}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    const pub = base64UrlToBytes(publicKeyB64);
    const d = base64UrlToBytes(privateKeyB64);
    if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY precisa ser um ponto P-256 não comprimido (65 bytes, base64url)");
    if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY precisa ter 32 bytes (base64url)");
    const jwk: JsonWebKey = {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(pub.slice(1, 33)),
      y: bytesToBase64Url(pub.slice(33, 65)),
      d: bytesToBase64Url(d),
      ext: false,
    };
    key = crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    keyCache.set(cacheKey, key);
  }
  return key;
}

function vapidSubject(env: AppEnv): string {
  const s = env.VAPID_SUBJECT?.trim();
  if (s) return s;
  const url = (env.PUBLIC_URL ?? "").trim();
  return url.startsWith("https://") ? url : "mailto:admin@puxibot.local";
}

/** JWT ES256 para o `aud` (origem do endpoint de push). Válido por 12 h. */
export async function vapidJwt(env: AppEnv, audience: string, now = Date.now()): Promise<string> {
  const enc = new TextEncoder();
  const header = bytesToBase64Url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(
    enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapidSubject(env) })),
  );
  const key = await importVapidKey(env.VAPID_PUBLIC_KEY!.trim(), env.VAPID_PRIVATE_KEY!.trim());
  // WebCrypto devolve a assinatura ECDSA já no formato r||s (64 bytes) exigido pelo JWS.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

export const MAX_PUSH_SUBSCRIPTIONS = 10;

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * O endpoint de push vem do navegador (controlado por quem se inscreve) e o hub faz POST nele a cada notificação.
 * Só HTTPS, porta padrão, e nada de destinos internos óbvios (localhost, IPs privados/link-local, IPv6 literal,
 * nomes sem ponto ou de rede interna). Serviços reais (FCM, Mozilla, Apple, WNS) usam nomes públicos em HTTPS.
 */
export function pushEndpointProblem(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "Endereço de push inválido.";
  }
  if (u.protocol !== "https:") return "O endereço de push precisa usar https.";
  if (u.username || u.password) return "Endereço de push inválido.";
  if (u.port && u.port !== "443") return "O endereço de push precisa usar a porta padrão.";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host.includes(".") ||
    host.startsWith("[") ||
    host.includes(":") ||
    isPrivateIpv4(host) ||
    host === "localhost" ||
    /\.(localhost|local|internal|intranet|lan|home|corp|test|invalid)$/.test(host)
  ) {
    return "Endereço de push não permitido.";
  }
  return null;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

/**
 * Envia um push sem payload. Devolve o status HTTP do serviço de push.
 * 404/410 = inscrição expirada (quem chama apaga a linha).
 */
export async function sendEmptyPush(env: AppEnv, endpoint: string): Promise<number> {
  const audience = new URL(endpoint).origin;
  const jwt = await vapidJwt(env, audience);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY!.trim()}`,
      TTL: "86400",
      Urgency: "normal",
      "Content-Length": "0",
    },
    signal: AbortSignal.timeout(8000),
  });
  // Corpo descartado; só o status importa.
  await res.body?.cancel();
  return res.status;
}

/** Canal de entrega registrado em `registerNotificationDelivery`. */
export async function deliverPush(ctx: HubCtx, userId: string): Promise<void> {
  if (!vapidConfigured(ctx.env)) return;
  const subs = await all<PushSubscriptionRow>(ctx.env.DB, "SELECT * FROM push_subscriptions WHERE user_id = ?", userId);
  for (const sub of subs) {
    if (pushEndpointProblem(sub.endpoint)) continue; // gravado antes da validação: não chama
    try {
      const status = await sendEmptyPush(ctx.env, sub.endpoint);
      if (status === 404 || status === 410) await run(ctx.env.DB, "DELETE FROM push_subscriptions WHERE id = ?", sub.id);
      else if (status >= 400) console.warn(JSON.stringify({ msg: "push rejected", status, host: new URL(sub.endpoint).host }));
    } catch (err) {
      console.warn(JSON.stringify({ msg: "push failed", error: String(err) }));
    }
  }
}
