import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { MEMORY_REVIEW_GRACE_MS, type Role } from "@puxibot/shared";
import { SESSION_TTL_MS } from "../env";
import { first, run } from "../lib/db";
import { forbidden, notFound, unauthorized } from "../lib/errors";
import { randomHex, sha256Hex } from "../lib/crypto";
import { verifyJobToken } from "../lib/jobToken";
import { workerCtx } from "../domain/context";
import { getMember, isAdminRole, ROLE_RANK } from "../domain/members";
import type { ApiTokenRow } from "../domain/rows";
import type { AuthInfo, BaseEnv, ToolEnv, WsEnv } from "./types";

export const SESSION_COOKIE = "tb_session";

function isLocalhost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

export async function startSession(c: Context, userId: string): Promise<void> {
  const id = randomHex(32);
  const now = Date.now();
  await run(
    c.env.DB,
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    id,
    userId,
    now,
    now + SESSION_TTL_MS,
  );
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: !isLocalhost(c.req.url),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function endSession(c: Context<BaseEnv>): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await run(c.env.DB, "DELETE FROM sessions WHERE id = ?", id);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: !isLocalhost(c.req.url) });
}

function bearer(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Identifica o chamador (sessão por cookie ou token `tb_...`) e grava em `c.var.auth`.
 * Não bloqueia: rotas que exigem login usam `requireUser`/`requireSession`/`requireMember`.
 * Tokens de job (`tbj_...`) são tratados só por `requireJob`.
 */
export const identify: MiddlewareHandler<BaseEnv> = async (c, next) => {
  c.set("auth", null);
  const token = bearer(c);
  if (token?.startsWith("tb_")) {
    const hash = await sha256Hex(token);
    const row = await first<ApiTokenRow>(c.env.DB, "SELECT * FROM api_tokens WHERE token_hash = ?", hash);
    if (row) {
      c.set("auth", {
        kind: "token",
        userId: row.user_id,
        tokenId: row.id,
        tokenKind: row.kind,
        workspaceId: row.workspace_id,
      });
      const now = Date.now();
      if (!row.last_used_at || now - row.last_used_at > 60_000) {
        c.executionCtx.waitUntil(run(c.env.DB, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now, row.id));
      }
    }
  } else {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) {
      const row = await first<{ user_id: string; expires_at: number }>(
        c.env.DB,
        "SELECT user_id, expires_at FROM sessions WHERE id = ?",
        sid,
      );
      if (row && row.expires_at > Date.now()) c.set("auth", { kind: "session", userId: row.user_id, sessionId: sid });
    }
  }
  await next();
};

/** Exige pessoa logada (sessão ou token pessoal). Tokens de runner só valem onde `allowRunnerToken`. */
export function requireUser(opts: { allowRunnerToken?: boolean } = {}): MiddlewareHandler<BaseEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw unauthorized();
    if (auth.kind === "token" && auth.tokenKind === "runner" && !opts.allowRunnerToken) {
      throw forbidden("Token de runner não vale para esta rota.", "runner_token_not_allowed");
    }
    await next();
  };
}

export function assertSession(auth: AuthInfo | null): void {
  if (!auth) throw unauthorized();
  if (auth.kind !== "session") throw forbidden("Esta ação precisa ser feita pela interface, com sessão.", "session_required");
}

export const requireSession: MiddlewareHandler<BaseEnv> = async (c, next) => {
  assertSession(c.get("auth"));
  await next();
};

export function authUserId(c: Context<BaseEnv>): string {
  const auth = c.get("auth");
  if (!auth) throw unauthorized();
  return auth.userId;
}

/**
 * Rotas sob /api/workspaces/:ws: exige membro do workspace. Token só vale para o próprio workspace;
 * token de runner só vale no WebSocket `/runner`.
 */
export const requireMember: MiddlewareHandler<WsEnv> = async (c, next) => {
  const auth = c.get("auth") as AuthInfo | null;
  if (!auth) throw unauthorized();
  const wsId = c.req.param("ws");
  if (!wsId) throw forbidden();
  if (auth.kind === "token") {
    if (auth.workspaceId !== wsId) throw forbidden("Este token é de outro workspace.", "token_wrong_workspace");
    const path = new URL(c.req.url).pathname;
    const isRunnerSocket = path === `/api/workspaces/${wsId}/runner`;
    // O runner pode remover o próprio registro (`puxibot logout`); a rota confere que é o mesmo token.
    const isRunnerSelfDelete = c.req.method === "DELETE" && path.startsWith(`/api/workspaces/${wsId}/runners/`);
    if (auth.tokenKind === "runner" && !isRunnerSocket && !isRunnerSelfDelete) {
      throw forbidden("Token de runner só vale para a conexão do runner.", "runner_token_not_allowed");
    }
  }
  const member = await getMember(c.env.DB, wsId, auth.userId);
  // 404 em vez de 403: não revela se o workspace existe.
  if (!member) throw notFound("Workspace não encontrado.");
  c.set("userId", auth.userId);
  c.set("wsId", wsId);
  c.set("member", member);
  c.set("hub", workerCtx(c.env, wsId));
  await next();
};

export function isAdmin(c: Context<WsEnv>): boolean {
  return isAdminRole(c.get("member").role);
}

export function assertAdmin(c: Context<WsEnv>, message = "Só admins podem fazer isso."): void {
  if (!isAdmin(c)) throw forbidden(message, "admin_required");
}

export function hasRole(c: Context<WsEnv>, role: Role): boolean {
  return ROLE_RANK[c.get("member").role] >= ROLE_RANK[role];
}

/**
 * Rotas /api/tool/*: exige token de job válido (assinatura, expiração) e job ainda `assigned`/`running`.
 * O ator é o agente do token.
 */
/** As duas chamadas da revisão de memória: ler as memórias atuais e mandar o resultado. */
function isMemoryReviewRequest(method: string, pathname: string): boolean {
  return (
    (method === "GET" && pathname === "/api/tool/memories") ||
    (method === "POST" && (pathname === "/api/tool/memories/review" || pathname === "/api/tool/skills/learned"))
  );
}

export const requireJob: MiddlewareHandler<ToolEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token?.startsWith("tbj_")) throw unauthorized("Token de job ausente.");
  const claims = await verifyJobToken(c.env.JOB_TOKEN_SECRET, token);
  if (!claims) throw unauthorized("Token de job inválido ou expirado.");
  const job = await first<{ status: string; finished_at: number | null; requested_by_user_id: string | null; owner_user_id: string }>(
    c.env.DB,
    `SELECT j.status, j.finished_at, j.requested_by_user_id, a.owner_user_id FROM jobs j JOIN agents a ON a.id = j.agent_id
     WHERE j.workspace_id = ? AND j.id = ? AND j.agent_id = ?`,
    claims.workspaceId,
    claims.jobId,
    claims.agentId,
  );
  // Única exceção ao "só em execução": a revisão de memória, que o runner faz logo depois de
  // entregar a resposta (para não atrasá-la), por uma janela curta e só nas rotas dela.
  const reviewGrace =
    job?.status === "done" &&
    job.finished_at !== null &&
    Date.now() - job.finished_at <= MEMORY_REVIEW_GRACE_MS &&
    isMemoryReviewRequest(c.req.method, new URL(c.req.url).pathname);
  if (!job || (job.status !== "assigned" && job.status !== "running" && !reviewGrace)) {
    throw unauthorized("Este job não está mais em execução.");
  }
  c.set("job", { ...claims, requestedByUserId: job.requested_by_user_id, agentOwnerUserId: job.owner_user_id });
  c.set("hub", workerCtx(c.env, claims.workspaceId));
  await next();
};
