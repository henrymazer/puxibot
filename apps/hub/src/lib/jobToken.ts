import { hmacSign, hmacVerify, bytesToBase64Url, base64UrlToBytes } from "./crypto";

/** Conteúdo do token de job ("tbj_<payload>.<assinatura>"), assinado com HMAC-SHA256 (`JOB_TOKEN_SECRET`). */
export interface JobTokenClaims {
  jobId: string;
  agentId: string;
  workspaceId: string;
  /** Expiração em ms desde epoch. */
  exp: number;
}

const PREFIX = "tbj_";

export async function issueJobToken(secret: string, claims: JobTokenClaims): Promise<string> {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ j: claims.jobId, a: claims.agentId, w: claims.workspaceId, e: claims.exp })),
  );
  return `${PREFIX}${payload}.${await hmacSign(secret, payload)}`;
}

/**
 * Verifica assinatura e expiração. Não consulta o banco: quem usa (middleware `requireJob`)
 * ainda precisa conferir se o job está `assigned` ou `running`.
 */
export async function verifyJobToken(secret: string, token: string, now = Date.now()): Promise<JobTokenClaims | null> {
  if (!token.startsWith(PREFIX)) return null;
  const [payload, sig] = token.slice(PREFIX.length).split(".");
  if (!payload || !sig) return null;
  if (!(await hmacVerify(secret, payload, sig))) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as {
      j?: unknown;
      a?: unknown;
      w?: unknown;
      e?: unknown;
    };
    if (typeof raw.j !== "string" || typeof raw.a !== "string" || typeof raw.w !== "string" || typeof raw.e !== "number") {
      return null;
    }
    if (raw.e <= now) return null;
    return { jobId: raw.j, agentId: raw.a, workspaceId: raw.w, exp: raw.e };
  } catch {
    return null;
  }
}
