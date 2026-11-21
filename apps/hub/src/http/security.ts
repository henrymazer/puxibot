import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { base64ToBytes } from "../lib/crypto";
import { errorBody } from "../lib/errors";
import type { BaseEnv } from "./types";

const SESSION_COOKIE = "tb_session";

export function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

// ---------- Segredos ----------
/** Valores conhecidos (testes, exemplos): nunca valem fora de localhost. */
const KNOWN_WEAK_SECRETS = new Set([
  "test-job-token-secret",
  "change-me",
  "changeme",
  "secret",
  "dev",
  "development",
]);

/** Problema de configuração dos segredos obrigatórios, ou null se estão bons. */
export function secretsProblem(env: Pick<AppEnv, "JOB_TOKEN_SECRET" | "SECRETS_KEY">): string | null {
  const job = (env.JOB_TOKEN_SECRET ?? "").trim();
  const key = (env.SECRETS_KEY ?? "").trim();
  if (!job) return "JOB_TOKEN_SECRET não está definido.";
  if (job.length < 32) return "JOB_TOKEN_SECRET é curto demais (mínimo de 32 caracteres).";
  if (KNOWN_WEAK_SECRETS.has(job)) return "JOB_TOKEN_SECRET está com um valor de desenvolvimento/teste.";
  if (new Set(job).size < 8) return "JOB_TOKEN_SECRET tem pouca variedade de caracteres.";
  if (!key) return "SECRETS_KEY não está definido.";
  if (KNOWN_WEAK_SECRETS.has(key)) return "SECRETS_KEY está com um valor de desenvolvimento/teste.";
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(key);
  } catch {
    return "SECRETS_KEY não é base64 válido.";
  }
  if (raw.length !== 32) return "SECRETS_KEY precisa ser base64 de 32 bytes.";
  // Sequência 0, 1, 2… 31: chave de exemplo que já circulou em versões antigas dos testes.
  if (raw.every((b, i) => b === i)) return "SECRETS_KEY está com um valor de desenvolvimento/teste.";
  if (new Set(raw).size < 12) return "SECRETS_KEY tem pouca variedade (não parece aleatório).";
  if (key === job) return "JOB_TOKEN_SECRET e SECRETS_KEY não podem ser iguais.";
  return null;
}

/**
 * Fora de localhost, o hub se recusa a funcionar com segredos ausentes, fracos ou de desenvolvimento/teste
 * (com eles, qualquer pessoa forjaria tokens de job ou decifraria conectores). Em localhost (dev e testes) passa.
 */
export const requireStrongSecrets: MiddlewareHandler<BaseEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  if (!isLocalHostname(url.hostname)) {
    const problem = secretsProblem(c.env);
    if (problem) {
      console.error(JSON.stringify({ msg: "insecure config", problem }));
      return c.json(
        errorBody(
          "insecure_config",
          `O hub está com uma configuração insegura e não vai funcionar assim: ${problem} ` +
            "Gere valores novos (ex.: `openssl rand -base64 32`) e defina com `wrangler secret put`.",
        ),
        500,
      );
    }
  }
  await next();
};

// ---------- CSRF / Cross-Site WebSocket Hijacking ----------
function allowedOrigin(env: AppEnv, requestUrl: URL, origin: string): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.origin === requestUrl.origin) return true;
  const configured = (env.PUBLIC_URL ?? "").trim();
  if (configured) {
    try {
      if (new URL(configured).origin === o.origin) return true;
    } catch {
      // PUBLIC_URL inválida: ignora
    }
  }
  // Desenvolvimento: interface no Vite (localhost:5173) com proxy para o hub (localhost:8787).
  return isLocalHostname(requestUrl.hostname) && isLocalHostname(o.hostname);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Requisições do navegador autenticadas por cookie que mudam estado (POST/PUT/PATCH/DELETE, inclusive
 * multipart) e o upgrade de WebSocket precisam vir da própria origem do app. Com `Authorization: Bearer`
 * (runner, scripts, MCP) não há cookie envolvido e a checagem não se aplica.
 */
export const originCheck: MiddlewareHandler<BaseEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  const isUpgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
  // Só dispensa a checagem quando a autenticação é mesmo por token (`identify` ignora o cookie nesse caso).
  const bearerToken = /^Bearer\s+tb_\S+$/i.test(c.req.header("Authorization") ?? "");
  if ((!SAFE_METHODS.has(method) || isUpgrade) && !bearerToken && getCookie(c, SESSION_COOKIE)) {
    const origin = c.req.header("Origin");
    const site = c.req.header("Sec-Fetch-Site")?.toLowerCase();
    const url = new URL(c.req.url);
    const ok = origin ? origin !== "null" && allowedOrigin(c.env, url, origin) : site !== "cross-site" && site !== "same-site";
    if (!ok) {
      return c.json(errorBody("csrf_origin", "Requisição recusada: origem não confere com o endereço do hub."), 403);
    }
  }
  await next();
};

// ---------- Cabeçalhos de segurança ----------
/** Respostas da API: JSON (ou stream de arquivo, que define o próprio CSP `sandbox`). */
export const apiSecurityHeaders: MiddlewareHandler<BaseEnv> = async (c, next) => {
  await next();
  if (c.res.status === 101) return; // upgrade de WebSocket: cabeçalhos imutáveis
  const h = c.res.headers;
  // Arquivo aberto no navegador (`?inline=1`: imagem, PDF, texto, áudio, vídeo): a pré-visualização do
  // drive mostra o PDF num <iframe> da própria interface, então só a mesma origem pode emoldurá-lo.
  const frame = /^inline\b/i.test(h.get("Content-Disposition") ?? "") ? "SAMEORIGIN" : "DENY";
  try {
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "no-referrer");
    h.set("X-Frame-Options", frame);
    h.set("Cross-Origin-Resource-Policy", "same-origin");
    if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  } catch {
    // resposta com cabeçalhos imutáveis (repassada de outro fetch): recria
    const res = new Response(c.res.body, c.res);
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("X-Frame-Options", frame);
    if (!res.headers.has("Content-Security-Policy")) res.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    c.res = res;
  }
};
