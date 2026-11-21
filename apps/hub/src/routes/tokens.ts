import { Hono } from "hono";
import { z } from "zod";
import type { ApiTokenDTO } from "@puxibot/shared";
import { PAIRING_TTL_MS, publicUrl } from "../env";
import { all, first, newId, run } from "../lib/db";
import { forbidden, HttpError, notFound } from "../lib/errors";
import { decryptString, encryptString, randomCode, randomToken, sha256Hex } from "../lib/crypto";
import { readBody } from "../lib/validate";
import { clientIp, enforce } from "../lib/rateLimit";
import { assertSession, isAdmin } from "../http/auth";
import type { BaseEnv, WsEnv } from "../http/types";
import type { ApiTokenRow, RunnerRow } from "../domain/rows";
import { links } from "../domain/notify";
import { listRunnerDTOs } from "./workspaces";

function toApiTokenDTO(r: ApiTokenRow): ApiTokenDTO {
  return { id: r.id, name: r.name, kind: r.kind, createdAt: r.created_at, lastUsedAt: r.last_used_at };
}

/** Cria um token `tb_...` e devolve o valor em claro (só desta vez). */
export async function issueApiToken(
  db: D1Database,
  input: { userId: string; wsId: string; name: string; kind: "personal" | "runner" },
): Promise<{ token: string; row: ApiTokenRow }> {
  const token = randomToken("tb_");
  const row: ApiTokenRow = {
    id: newId(),
    user_id: input.userId,
    workspace_id: input.wsId,
    name: input.name,
    kind: input.kind,
    token_hash: await sha256Hex(token),
    created_at: Date.now(),
    last_used_at: null,
  };
  await run(
    db,
    `INSERT INTO api_tokens (id, user_id, workspace_id, name, kind, token_hash, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    row.id,
    row.user_id,
    row.workspace_id,
    row.name,
    row.kind,
    row.token_hash,
    row.created_at,
  );
  return { token, row };
}

/** /api/workspaces/:ws/tokens, /runners, /runner/pair/approve */
export const tokenRoutes = new Hono<WsEnv>();

tokenRoutes.get("/tokens", async (c) => {
  const rows = await all<ApiTokenRow>(
    c.env.DB,
    "SELECT * FROM api_tokens WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC",
    c.get("wsId"),
    c.get("userId"),
  );
  return c.json({ items: rows.map(toApiTokenDTO) });
});

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["personal", "runner"]).default("personal"),
});

// Criar token exige sessão (a interface): um token pessoal vazado não fabrica outros (nem de runner).
tokenRoutes.post("/tokens", async (c) => {
  assertSession(c.get("auth"));
  const body = await readBody(c, createTokenSchema);
  const { token, row } = await issueApiToken(c.env.DB, { userId: c.get("userId"), wsId: c.get("wsId"), ...body });
  return c.json({ token, apiToken: toApiTokenDTO(row) }, 201);
});

tokenRoutes.delete("/tokens/:id", async (c) => {
  const changed = await run(
    c.env.DB,
    "DELETE FROM api_tokens WHERE workspace_id = ? AND user_id = ? AND id = ?",
    c.get("wsId"),
    c.get("userId"),
    c.req.param("id"),
  );
  if (changed === 0) throw notFound("Token não encontrado.");
  return c.body(null, 204);
});

tokenRoutes.get("/runners", async (c) => {
  const presence = await c.get("hub").rt.presence();
  return c.json({ items: await listRunnerDTOs(c.env.DB, c.get("wsId"), presence) });
});

tokenRoutes.delete("/runners/:id", async (c) => {
  const wsId = c.get("wsId");
  const runner = await first<RunnerRow>(c.env.DB, "SELECT * FROM runners WHERE workspace_id = ? AND id = ?", wsId, c.req.param("id"));
  if (!runner) throw notFound("Runner não encontrado.");
  const auth = c.get("auth");
  if (auth.kind === "token" && auth.tokenKind === "runner") {
    // Token de runner: só remove o runner que conectou com este mesmo token.
    if (runner.token_id !== auth.tokenId) throw forbidden("Este token de runner só remove o próprio runner.", "runner_token_not_allowed");
  } else if (runner.user_id !== c.get("userId") && !isAdmin(c)) {
    throw forbidden("Só o dono do runner ou um admin pode removê-lo.");
  }
  await c.get("hub").rt.disconnectRunner(runner.id);
  await run(c.env.DB, "DELETE FROM runners WHERE workspace_id = ? AND id = ?", wsId, runner.id);
  return c.body(null, 204);
});

// ---------- Pareamento ----------
interface PairingRow {
  pair_code: string;
  poll_token_hash: string;
  name: string;
  status: "pending" | "approved";
  workspace_id: string | null;
  user_id: string | null;
  token_enc: string | null;
  created_at: number;
  expires_at: number;
}

const approveSchema = z.object({ pairCode: z.string().trim().min(4).max(20) });

tokenRoutes.post("/runner/pair/approve", async (c) => {
  assertSession(c.get("auth"));
  // Contra adivinhar códigos de outra pessoa (o que ligaria o runner DELA à conta de quem aprovou).
  await enforce(c, `pairapprove:user:${c.get("userId")}`, 10, PAIRING_TTL_MS, "Muitas tentativas de pareamento. Espere alguns minutos.");
  const body = await readBody(c, approveSchema);
  const code = body.pairCode.toUpperCase();
  const pairing = await first<PairingRow>(
    c.env.DB,
    "SELECT * FROM runner_pairings WHERE pair_code = ? AND status = 'pending' AND expires_at > ?",
    code,
    Date.now(),
  );
  if (!pairing) throw notFound("Código de pareamento não encontrado ou expirado.");
  const { token } = await issueApiToken(c.env.DB, {
    userId: c.get("userId"),
    wsId: c.get("wsId"),
    name: `Runner: ${pairing.name}`,
    kind: "runner",
  });
  const changed = await run(
    c.env.DB,
    `UPDATE runner_pairings SET status = 'approved', workspace_id = ?, user_id = ?, token_enc = ?
     WHERE pair_code = ? AND status = 'pending'`,
    c.get("wsId"),
    c.get("userId"),
    await encryptString(c.env.SECRETS_KEY, token),
    code,
  );
  if (changed === 0) throw notFound("Código de pareamento não encontrado ou expirado.");
  return c.json({ ok: true, name: pairing.name });
});

/** /api/runner/pair/start e /poll (sem auth) */
export const pairingRoutes = new Hono<BaseEnv>();

const startSchema = z.object({ name: z.string().trim().min(1).max(80) });

pairingRoutes.post("/runner/pair/start", async (c) => {
  const ip = clientIp(c);
  if (ip) await enforce(c, `pairstart:ip:${ip}`, 20, PAIRING_TTL_MS, "Muitos pareamentos a partir deste endereço. Espere alguns minutos.");
  const body = await readBody(c, startSchema);
  const now = Date.now();
  await run(c.env.DB, "DELETE FROM runner_pairings WHERE expires_at <= ?", now);
  const pollToken = randomToken("tbp_");
  const pairCode = randomCode();
  await run(
    c.env.DB,
    `INSERT INTO runner_pairings (pair_code, poll_token_hash, name, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    pairCode,
    await sha256Hex(pollToken),
    body.name,
    now,
    now + PAIRING_TTL_MS,
  );
  const approveUrl = `${publicUrl(c.env, new URL(c.req.url).origin)}${links.pair(pairCode)}`;
  return c.json({ pairCode, pollToken, approveUrl, expiresAt: now + PAIRING_TTL_MS }, 201);
});

const pollSchema = z.object({ pollToken: z.string().min(10).max(200) });

pairingRoutes.post("/runner/pair/poll", async (c) => {
  const body = await readBody(c, pollSchema);
  const pairing = await first<PairingRow>(
    c.env.DB,
    "SELECT * FROM runner_pairings WHERE poll_token_hash = ?",
    await sha256Hex(body.pollToken),
  );
  if (!pairing || (pairing.status === "pending" && pairing.expires_at <= Date.now())) {
    throw new HttpError(410, "pairing_expired", "Pareamento expirado ou inexistente. Comece de novo.");
  }
  if (pairing.status === "pending") return c.json({ status: "pending" as const });
  // Aprovado: entrega o token uma única vez e apaga o pareamento.
  const deleted = await run(c.env.DB, "DELETE FROM runner_pairings WHERE pair_code = ?", pairing.pair_code);
  if (deleted === 0 || !pairing.token_enc || !pairing.workspace_id) {
    throw new HttpError(410, "pairing_expired", "Pareamento expirado ou inexistente. Comece de novo.");
  }
  return c.json({
    status: "approved" as const,
    token: await decryptString(c.env.SECRETS_KEY, pairing.token_enc),
    workspaceId: pairing.workspace_id,
    hubUrl: publicUrl(c.env, new URL(c.req.url).origin),
  });
});

