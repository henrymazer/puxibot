/**
 * Canais de conversa (Telegram, WhatsApp), cofre de logins de sites e transcrição de voz.
 * As rotas de ferramenta do cofre (token de job) são usadas só pelo intermediário do navegador no runner.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { BROWSER_TOOL, type ChatLinkDTO, type VaultItemDTO } from "@puxibot/shared";
import { all, first, newId, run } from "../lib/db";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../lib/errors";
import { decryptJson, encryptJson } from "../lib/crypto";
import { enforce } from "../lib/rateLimit";
import { readBody } from "../lib/validate";
import type { ToolEnv, WsEnv } from "../http/types";
import { jobPrincipal } from "../domain/actor";
import { canTalkTo, requireAgentRow, toolPerms } from "../domain/agents";
import { chatLinkDTO, createChatLink, getChatLink, providerConfigured, type ChatProvider } from "../domain/chatChannels";
import { getJobRow } from "../domain/jobs";
import { checkAction, getAction, summarizeArgs } from "../domain/trust";

export const extraRoutes = new Hono<WsEnv>();

// ---------- O que este hub tem ligado ----------
extraRoutes.get("/features", (c) =>
  c.json({
    /** Transcrição de áudio no servidor (Workers AI). Sem ela, a interface usa o ditado do navegador. */
    transcription: !!c.env.AI,
    telegramChat: providerConfigured(c.env, "telegram"),
    whatsappChat: providerConfigured(c.env, "whatsapp"),
    /** A checagem de ações consegue comparar com o pedido (Workers AI). Sem ela, toda ação sem regra pede aprovação. */
    trustModel: !!c.env.AI,
  }),
);

// ---------- Canais de conversa ----------
const PROVIDERS: ChatProvider[] = ["telegram", "whatsapp"];

extraRoutes.get("/chat-links", async (c) => {
  const items: ChatLinkDTO[] = [];
  for (const p of PROVIDERS) items.push(await chatLinkDTO(c.env, p, await getChatLink(c.env.DB, c.get("userId"), p)));
  return c.json({ items });
});

extraRoutes.post("/chat-links", async (c) => {
  const body = await readBody(c, z.object({ provider: z.enum(["telegram", "whatsapp"]), agentId: z.string().min(1) }));
  if (!providerConfigured(c.env, body.provider)) throw notFound("Este canal não está configurado neste hub.");
  const agent = await requireAgentRow(c.env.DB, c.get("wsId"), body.agentId);
  if (agent.system_kind === "builder") throw badRequest("O agente criador conversa só pela interface.");
  if (!(await canTalkTo(c.env.DB, agent, c.get("userId")))) throw forbidden(`Você não tem permissão para falar com ${agent.name}.`);
  const row = await createChatLink(c.env.DB, { userId: c.get("userId"), provider: body.provider, workspaceId: c.get("wsId"), agentId: agent.id });
  return c.json(await chatLinkDTO(c.env, body.provider, row), 201);
});

extraRoutes.delete("/chat-links/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (provider !== "telegram" && provider !== "whatsapp") throw notFound("Canal desconhecido.");
  await run(c.env.DB, "DELETE FROM chat_links WHERE user_id = ? AND provider = ?", c.get("userId"), provider);
  return c.body(null, 204);
});

// ---------- Cofre ----------
interface VaultRow {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  name: string;
  origin: string;
  username: string;
  secret_enc: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

function toVaultDTO(r: VaultRow): VaultItemDTO {
  return { id: r.id, name: r.name, origin: r.origin, username: r.username, createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at };
}

/** Guarda só protocolo, host e porta: a senha vale para o site, não para um caminho. HTTP só em endereço local. */
export function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw badRequest("Endereço do site inválido. Use o domínio (ex.: app.exemplo.com) ou o endereço completo.");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw badRequest("O site precisa usar HTTPS.");
  if (u.username || u.password) throw badRequest("O endereço do site não pode conter usuário e senha.");
  return u.origin;
}

const vaultSchema = z.object({
  name: z.string().trim().min(1).max(80),
  site: z.string().trim().min(3).max(300),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
});

// Cada pessoa vê e muda só os próprios logins; nem admin enxerga os de outra pessoa.
async function ownVaultItem(c: Context<WsEnv>): Promise<VaultRow> {
  const row = await first<VaultRow>(c.env.DB, "SELECT * FROM vault_items WHERE workspace_id = ? AND id = ? AND owner_user_id = ?", c.get("wsId"), c.req.param("id")!, c.get("userId"));
  if (!row) throw notFound("Login não encontrado.");
  return row;
}

extraRoutes.get("/vault", async (c) => {
  const rows = await all<VaultRow>(c.env.DB, "SELECT * FROM vault_items WHERE workspace_id = ? AND owner_user_id = ? ORDER BY name COLLATE NOCASE", c.get("wsId"), c.get("userId"));
  return c.json({ items: rows.map(toVaultDTO) });
});

extraRoutes.post("/vault", async (c) => {
  const body = await readBody(c, vaultSchema);
  const origin = normalizeOrigin(body.site);
  if (await first(c.env.DB, "SELECT 1 AS one FROM vault_items WHERE workspace_id = ? AND owner_user_id = ? AND name = ? COLLATE NOCASE", c.get("wsId"), c.get("userId"), body.name)) {
    throw conflict("Você já tem um login com esse nome.", "vault_name_taken");
  }
  const now = Date.now();
  const row: VaultRow = {
    id: newId(),
    workspace_id: c.get("wsId"),
    owner_user_id: c.get("userId"),
    name: body.name,
    origin,
    username: body.username,
    secret_enc: await encryptJson(c.env.SECRETS_KEY, { password: body.password }),
    created_at: now,
    updated_at: now,
    last_used_at: null,
  };
  await run(
    c.env.DB,
    "INSERT INTO vault_items (id, workspace_id, owner_user_id, name, origin, username, secret_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.id,
    row.workspace_id,
    row.owner_user_id,
    row.name,
    row.origin,
    row.username,
    row.secret_enc,
    now,
    now,
  );
  return c.json(toVaultDTO(row), 201);
});

extraRoutes.patch("/vault/:id", async (c) => {
  const row = await ownVaultItem(c);
  const body = await readBody(c, vaultSchema.partial());
  const next: VaultRow = {
    ...row,
    name: body.name ?? row.name,
    origin: body.site !== undefined ? normalizeOrigin(body.site) : row.origin,
    username: body.username ?? row.username,
    secret_enc: body.password !== undefined ? await encryptJson(c.env.SECRETS_KEY, { password: body.password }) : row.secret_enc,
    updated_at: Date.now(),
  };
  // Trocar o site sem informar a senha de novo mandaria a senha de um site para outro.
  if (next.origin !== row.origin && body.password === undefined) throw badRequest("Para mudar o site, informe a senha de novo.");
  await run(
    c.env.DB,
    "UPDATE vault_items SET name = ?, origin = ?, username = ?, secret_enc = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    next.name,
    next.origin,
    next.username,
    next.secret_enc,
    next.updated_at,
    c.get("wsId"),
    row.id,
  );
  return c.json(toVaultDTO(next));
});

extraRoutes.delete("/vault/:id", async (c) => {
  const row = await ownVaultItem(c);
  await run(c.env.DB, "DELETE FROM vault_items WHERE workspace_id = ? AND id = ?", c.get("wsId"), row.id);
  return c.body(null, 204);
});

// ---------- Voz ----------
export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Transcreve um áudio curto gravado no navegador. O áudio não é guardado. */
extraRoutes.post("/transcribe", async (c) => {
  if (!c.env.AI) throw notFound("Transcrição no servidor não está ligada neste hub.");
  await enforce(c, `transcribe:${c.get("userId")}`, 60, 60 * 60_000, "Muitas transcrições em pouco tempo. Tente de novo daqui a pouco.");
  const type = (c.req.header("Content-Type") ?? "").toLowerCase();
  if (!/^audio\/|^video\/webm/.test(type)) throw badRequest("Envie um arquivo de áudio.");
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_AUDIO_BYTES) throw new HttpError(413, "too_large", "Áudio grande demais (máximo 8 MB).");
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) throw badRequest("Áudio vazio.");
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, "too_large", "Áudio grande demais (máximo 8 MB).");
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  try {
    const ai = c.env.AI as unknown as { run(model: string, inputs: unknown): Promise<{ text?: string }> };
    const out = await ai.run(TRANSCRIBE_MODEL, { audio: btoa(binary), language: "pt" });
    return c.json({ text: (out?.text ?? "").trim() });
  } catch (err) {
    console.warn(JSON.stringify({ msg: "transcribe failed", error: String(err) }));
    throw new HttpError(502, "transcribe_failed", "Não foi possível transcrever o áudio agora.");
  }
});

// ---------- Cofre: ferramentas do intermediário do navegador ----------
export const vaultToolRoutes = new Hono<ToolEnv>();

async function vaultCtx(c: Context<ToolEnv>) {
  const claims = c.get("job");
  const db = c.env.DB;
  const [agent, job, perms] = await Promise.all([requireAgentRow(db, claims.workspaceId, claims.agentId), getJobRow(db, claims.workspaceId, claims.jobId), toolPerms(db, claims.agentId)]);
  if (!job) throw new HttpError(401, "unauthorized", "Este job não existe mais.");
  if ((perms[BROWSER_TOOL] ?? "none") === "none") throw forbidden(`${agent.name} não tem o navegador ligado.`, "tool_permission_denied");
  return { agent, job, wsId: claims.workspaceId, db };
}

/**
 * Logins que um trabalho pode usar: os da pessoa por quem o agente age, e só quando o trabalho roda no
 * computador dela. A senha de uma pessoa nunca vai para o computador de outra.
 */
export async function usableVaultItems(db: D1Database, wsId: string, job: { requested_by_user_id: string | null; runner_user_id: string | null }, agent: { owner_user_id: string }): Promise<VaultRow[]> {
  const principal = jobPrincipal(job, agent);
  if (!job.runner_user_id || job.runner_user_id !== principal) return [];
  return all<VaultRow>(db, "SELECT * FROM vault_items WHERE workspace_id = ? AND owner_user_id = ? ORDER BY name COLLATE NOCASE", wsId, principal);
}

const vaultArgs = (item: VaultRow) => ({ login: item.name, site: item.origin });

/** Pede para usar um login: passa pela mesma checagem das ações (regra, pedido ou aprovação). */
vaultToolRoutes.post("/vault/use", async (c) => {
  const t = await vaultCtx(c);
  const { name } = await readBody(c, z.object({ name: z.string().trim().min(1).max(80) }));
  const item = (await usableVaultItems(t.db, t.wsId, t.job, t.agent)).find((i) => i.name === name);
  if (!item) throw notFound(`Não há login "${name}" disponível para este trabalho.`);
  return c.json(await checkAction(c.get("hub"), { connectorId: BROWSER_TOOL, tool: "cofre_entrar", readOnly: false, args: vaultArgs(item), agent: t.agent, job: t.job, connectorName: "Navegador" }));
});

/** Entrega a senha, uma única vez, para uma ação de login já liberada deste mesmo trabalho. */
vaultToolRoutes.post("/vault/secret", async (c) => {
  const t = await vaultCtx(c);
  const { actionId } = await readBody(c, z.object({ actionId: z.string().min(1).max(64) }));
  const action = await getAction(t.db, t.wsId, actionId);
  if (!action || action.job_id !== t.job.id || action.tool !== "cofre_entrar" || action.connector_id !== BROWSER_TOOL) throw notFound("Ação não encontrada.");
  if (action.decision !== "allowed") throw forbidden("Este login não foi liberado.");
  const item = (await usableVaultItems(t.db, t.wsId, t.job, t.agent)).find((i) => summarizeArgs(vaultArgs(i)) === action.summary);
  if (!item) throw notFound("O login não está mais disponível.");
  // Uso único: a mesma liberação não entrega a senha duas vezes.
  const claimed = await run(t.db, "UPDATE agent_actions SET finished_at = ? WHERE workspace_id = ? AND id = ? AND status = 'pending' AND finished_at IS NULL", Date.now(), t.wsId, action.id);
  if (claimed === 0) throw conflict("Esta liberação já foi usada.", "vault_already_used");
  const secret = await decryptJson<{ password: string }>(c.env.SECRETS_KEY, item.secret_enc);
  await run(t.db, "UPDATE vault_items SET last_used_at = ? WHERE workspace_id = ? AND id = ?", Date.now(), t.wsId, item.id);
  return c.json({ username: item.username, password: secret.password, origin: item.origin }, 200, { "Cache-Control": "no-store" });
});
