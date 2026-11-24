/**
 * Login OAuth de conectores MCP, feito pelo hub: a pessoa clica em "Entrar", autoriza no site do serviço e
 * o hub guarda o acesso cifrado e o renova. O runner recebe só um token de acesso recém-emitido a cada
 * trabalho; o token de renovação nunca sai do hub.
 *
 * Usa o fluxo padrão do protocolo MCP (descoberta RFC 9728/8414, registro automático de cliente, PKCE S256)
 * pela função `auth()` do SDK oficial, do mesmo jeito que o Nod (n8n-io/nod, src/providers/discovered/oauth.ts).
 * Serviços que não aceitam registro automático recebem o id de um cliente que a pessoa registrou.
 *
 * O hub só fala com endereços públicos por HTTPS: toda chamada do fluxo (inclusive as que o servidor do
 * conector indica, como o endereço do servidor de autorização) passa por `guardedFetch`.
 */
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { isPrivateHost } from "@puxibot/shared";
import { publicUrl, type AppEnv } from "../env";
import { decryptJson, encryptJson, randomHex, sha256Hex } from "../lib/crypto";
import { first, run } from "../lib/db";
import { badRequest, forbidden, HttpError, notFound } from "../lib/errors";
import type { ConnectorRow } from "./rows";

export const OAUTH_FLOW_TTL_MS = 10 * 60_000;
/** Renova quando faltar menos que isto: um trabalho dura até 30 minutos. */
const REFRESH_MARGIN_MS = 35 * 60_000;

export interface OAuthSaved {
  redirectUri: string;
  scope?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  verifier?: string;
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Endereço aceito pelo hub em qualquer passo do login: HTTPS, host público, sem usuário e senha. */
export function assertPublicHttps(raw: string | URL): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("Endereço inválido.");
  }
  if (u.protocol !== "https:" || u.username || u.password || isPrivateHost(u.hostname)) {
    throw badRequest(`O hub só faz login em endereços públicos por HTTPS (recusado: ${u.origin}).`, "oauth_address");
  }
  return u;
}

/** `fetch` que confere cada endereço, inclusive os de redirecionamento, e não segue mais de três. */
const guardedFetch: FetchFn = async (input, init) => {
  let url = assertPublicHttps(input);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(15_000) });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
    if (!location) return res;
    // Só leituras seguem redirecionamento: um POST com credenciais nunca é reenviado a outro endereço.
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw badRequest("O servidor de login redirecionou um envio de dados; recusado.", "oauth_address");
    url = assertPublicHttps(new URL(location, url));
  }
  throw badRequest("O servidor de login redireciona demais.", "oauth_address");
};

let oauthFetch: FetchFn = guardedFetch;
/** Troca o `fetch` do fluxo (testes). Sem argumento, volta ao que confere os endereços. */
export function setOAuthFetch(fn?: FetchFn): void {
  oauthFetch = fn ?? guardedFetch;
}

async function runAuth(endpoint: string, saved: OAuthSaved, opts: { state?: string; code?: string }): Promise<{ result: "AUTHORIZED" | "REDIRECT"; url?: string }> {
  let url: string | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: saved.redirectUri,
    clientMetadata: {
      client_name: "Puxibot",
      redirect_uris: [saved.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Cliente público: a prova é o PKCE, não um segredo guardado.
      token_endpoint_auth_method: "none",
      ...(saved.scope ? { scope: saved.scope } : {}),
    },
    state: () => opts.state ?? "",
    clientInformation: () => saved.clientInformation,
    saveClientInformation: (value) => {
      saved.clientInformation = value;
    },
    tokens: () => saved.tokens,
    saveTokens: (value) => {
      saved.tokens = value;
      saved.expiresAt = value.expires_in === undefined ? undefined : Date.now() + value.expires_in * 1000;
    },
    redirectToAuthorization: (value) => {
      url = value.href;
    },
    saveCodeVerifier: (value) => {
      saved.verifier = value;
    },
    codeVerifier: () => {
      if (!saved.verifier) throw new Error("o pedido de login não está mais disponível");
      return saved.verifier;
    },
  };
  const result = await auth(provider, {
    serverUrl: endpoint,
    ...(opts.code ? { authorizationCode: opts.code } : {}),
    ...(saved.scope ? { scope: saved.scope } : {}),
    fetchFn: (input, init) => oauthFetch(input, init),
  });
  return { result, url };
}

/** Mensagem de erro do serviço sem nada que pareça credencial. */
function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/(access_token|refresh_token|code|client_secret|code_verifier)=[^&\s"]+/gi, "$1=[oculto]").replace(/Bearer\s+\S+/gi, "Bearer [oculto]").slice(0, 300);
}

export function oauthCallbackUrl(env: AppEnv, requestOrigin: string): string {
  return `${publicUrl(env, requestOrigin)}/api/oauth/callback`;
}

/**
 * Começa o login: devolve o endereço da tela de consentimento do serviço. O `state` volta no retorno e
 * identifica o fluxo; no banco fica só o hash dele.
 */
export async function beginOAuth(env: AppEnv, row: ConnectorRow, userId: string, requestOrigin: string): Promise<{ url: string }> {
  if (row.auth !== "oauth" || row.transport !== "http" || !row.url) throw badRequest("Este conector não usa login pelo navegador.");
  if (row.owner_user_id !== userId) throw forbidden("Só quem conectou este serviço faz o login dele.", "connector_owner_required");
  assertPublicHttps(row.url);
  const state = randomHex(24);
  const saved: OAuthSaved = {
    redirectUri: oauthCallbackUrl(env, requestOrigin),
    ...(row.oauth_scope ? { scope: row.oauth_scope } : {}),
    ...(row.oauth_client_id ? { clientInformation: { client_id: row.oauth_client_id } } : {}),
  };
  let out: Awaited<ReturnType<typeof runAuth>>;
  try {
    out = await runAuth(row.url, saved, { state });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`O serviço não aceitou iniciar o login: ${safeError(err)}`, "oauth_start_failed");
  }
  if (out.result !== "REDIRECT" || !out.url) throw badRequest("O serviço não devolveu um endereço de login.", "oauth_start_failed");
  const url = assertPublicHttps(out.url).href;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_flows WHERE connector_id = ? OR expires_at < ?").bind(row.id, now),
    env.DB
      .prepare("INSERT INTO oauth_flows (state_hash, workspace_id, connector_id, user_id, saved_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(state), row.workspace_id, row.id, userId, await encryptJson(env.SECRETS_KEY, saved), now, now + OAUTH_FLOW_TTL_MS),
  ]);
  return { url };
}

interface FlowRow {
  state_hash: string;
  workspace_id: string;
  connector_id: string;
  user_id: string;
  saved_enc: string;
  expires_at: number;
}

/**
 * Termina o login com o código que o serviço devolveu. O fluxo vale uma vez, por dez minutos, e só para a
 * pessoa que o começou (a sessão do navegador que volta precisa ser a dela).
 */
export async function finishOAuth(env: AppEnv, state: string, code: string, userId: string): Promise<{ workspaceId: string; connectorId: string }> {
  const hash = await sha256Hex(state);
  const flow = await first<FlowRow>(env.DB, "SELECT * FROM oauth_flows WHERE state_hash = ?", hash);
  // Uso único: o fluxo sai do banco antes de qualquer chamada externa.
  if (flow) await run(env.DB, "DELETE FROM oauth_flows WHERE state_hash = ?", hash);
  if (!flow || flow.expires_at < Date.now()) throw notFound("Este pedido de login expirou. Comece de novo pela tela de conectores.");
  if (flow.user_id !== userId) throw forbidden("Este login foi começado por outra pessoa.");
  const row = await first<ConnectorRow>(env.DB, "SELECT * FROM connectors WHERE workspace_id = ? AND id = ?", flow.workspace_id, flow.connector_id);
  if (!row || !row.url || row.owner_user_id !== userId) throw notFound("Conector não encontrado.");
  const saved = await decryptJson<OAuthSaved>(env.SECRETS_KEY, flow.saved_enc);
  try {
    const out = await runAuth(row.url, saved, { code });
    if (out.result !== "AUTHORIZED" || !saved.tokens?.access_token) throw new Error("o serviço não concluiu o login");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`O serviço recusou o login: ${safeError(err)}`, "oauth_finish_failed");
  }
  delete saved.verifier;
  await run(env.DB, "UPDATE connectors SET oauth_enc = ?, oauth_status = 'connected' WHERE workspace_id = ? AND id = ?", await encryptJson(env.SECRETS_KEY, saved), row.workspace_id, row.id);
  return { workspaceId: row.workspace_id, connectorId: row.id };
}

/**
 * Token de acesso válido para um trabalho, renovando se estiver perto de vencer. `null` = precisa de um
 * login novo (o conector fica marcado e a tela mostra "Entrar de novo").
 */
export async function freshAccessToken(env: AppEnv, row: ConnectorRow): Promise<string | null> {
  if (row.auth !== "oauth" || !row.url || !row.oauth_enc) return null;
  let saved: OAuthSaved;
  try {
    saved = await decryptJson<OAuthSaved>(env.SECRETS_KEY, row.oauth_enc);
  } catch {
    return null;
  }
  if (!saved.tokens?.access_token) return null;
  const expiring = saved.expiresAt !== undefined && saved.expiresAt - Date.now() < REFRESH_MARGIN_MS;
  if (!expiring) return saved.tokens.access_token;
  if (!saved.tokens.refresh_token) {
    // Sem renovação: vale enquanto não vencer de fato.
    if (saved.expiresAt! > Date.now() + 60_000) return saved.tokens.access_token;
    await markSignInRequired(env, row);
    return null;
  }
  try {
    const out = await runAuth(row.url, saved, {});
    if (out.result !== "AUTHORIZED" || !saved.tokens?.access_token) throw new Error("renovação não autorizada");
  } catch (err) {
    console.warn(JSON.stringify({ msg: "oauth refresh failed", connectorId: row.id, error: safeError(err) }));
    await markSignInRequired(env, row);
    return null;
  }
  await run(env.DB, "UPDATE connectors SET oauth_enc = ?, oauth_status = 'connected' WHERE workspace_id = ? AND id = ?", await encryptJson(env.SECRETS_KEY, saved), row.workspace_id, row.id);
  return saved.tokens.access_token;
}

async function markSignInRequired(env: AppEnv, row: ConnectorRow): Promise<void> {
  await run(env.DB, "UPDATE connectors SET oauth_status = 'signin_required' WHERE workspace_id = ? AND id = ?", row.workspace_id, row.id);
}
