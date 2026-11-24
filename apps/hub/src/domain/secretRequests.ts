/**
 * Pedido de segredo. O agente pede uma senha ou um token pela ferramenta `pedir_segredo`; a pessoa digita
 * numa caixa da interface; o valor vai do navegador para o hub, é cifrado e guardado no destino (cofre ou
 * conector). O agente só fica sabendo se foi guardado ou recusado: o valor nunca passa pela conversa, pelo
 * modelo nem pelo registro. O desenho segue a caixa de segredo de ferramentas como o T3 Code.
 */
import { z } from "zod";
import type { ApprovalDTO, SecretTargetDTO } from "@puxibot/shared";
import { first, newId, run } from "../lib/db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { decryptJson, encryptJson } from "../lib/crypto";
import { normalizeOrigin } from "../routes/extras";
import type { HubCtx } from "./context";
import { publishApproval } from "./jobs";
import { links, notify } from "./notify";
import type { AgentRow, ApprovalRow, ConnectorRow, JobRow } from "./rows";

export const MAX_PENDING_SECRET_REQUESTS = 3;

export const secretRequestSchema = z.object({
  label: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(1000),
  /** Página onde a pessoa consegue o valor (aparece como botão). */
  url: z.string().trim().max(500).optional(),
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("vault"),
      name: z.string().trim().min(1).max(80),
      site: z.string().trim().min(3).max(300),
      username: z.string().trim().min(1).max(200).optional(),
    }),
    z.object({ kind: z.literal("connector"), connector: z.string().trim().min(1).max(120) }),
  ]),
});
export type SecretRequestInput = z.infer<typeof secretRequestSchema>;

export const secretAnswerSchema = z.object({
  secret: z.string().min(1).max(4000).optional(),
  username: z.string().trim().min(1).max(200).optional(),
});

type Secrets = { headers?: Record<string, string>; env?: Record<string, string> };
type Slot = { group: "headers" | "env"; key: string };

/** O conector precisa ter exatamente um segredo: é esse que o valor novo substitui. */
export function singleSecretSlot(s: Secrets): Slot | null {
  const slots: Slot[] = [
    ...Object.keys(s.headers ?? {}).map((key) => ({ group: "headers" as const, key })),
    ...Object.keys(s.env ?? {}).map((key) => ({ group: "env" as const, key })),
  ];
  return slots.length === 1 ? slots[0]! : null;
}

/** Troca o valor mantendo o formato: um cabeçalho "Bearer ..." continua "Bearer ...". */
export function replaceSecret(s: Secrets, slot: Slot, value: string): Secrets {
  const current = s[slot.group]?.[slot.key] ?? "";
  const clean = value.trim();
  if (!clean || /[\r\n\0]/.test(clean)) throw badRequest("O valor não pode ficar vazio nem ter quebra de linha.");
  const next = slot.group === "headers" && /^Bearer\s/i.test(current) ? `Bearer ${clean.replace(/^Bearer\s+/i, "")}` : clean;
  return { ...s, [slot.group]: { ...s[slot.group], [slot.key]: next } };
}

function helpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("O link de ajuda é inválido.");
  }
  if (u.protocol !== "https:" || u.username || u.password) throw badRequest("O link de ajuda precisa ser HTTPS, sem usuário e senha.");
  return u.toString();
}

async function connectorSecrets(ctx: HubCtx, row: ConnectorRow): Promise<Secrets> {
  if (!row.secrets_enc) return {};
  return decryptJson<Secrets>(ctx.env.SECRETS_KEY, row.secrets_enc).catch(() => ({}));
}

/** Cria o pedido e avisa quem vai digitar. Devolve só o estado do pedido. */
export async function createSecretRequest(
  ctx: HubCtx,
  input: SecretRequestInput,
  who: { agent: AgentRow; job: JobRow; principalUserId: string; perms: Record<string, string> },
): Promise<ApprovalDTO> {
  const db = ctx.env.DB;
  const { agent, job } = who;
  if (job.mode === "prepare") throw forbidden("Preparação automática não pode pedir segredos.", "prepare_read_only");
  const pending = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM approvals WHERE workspace_id = ? AND job_id = ? AND kind = 'secret' AND status = 'pending'", ctx.wsId, job.id);
  if ((pending?.n ?? 0) >= MAX_PENDING_SECRET_REQUESTS) throw conflict("Já há pedidos de segredo esperando resposta neste trabalho.", "too_many_secret_requests");

  const url = helpUrl(input.url);
  let target: SecretTargetDTO;
  let approver: string;
  if (input.target.kind === "vault") {
    // O login vai para o cofre de quem pediu o trabalho: é a única pessoa cujos logins este agente pode usar.
    target = { target: "vault", name: input.target.name, origin: normalizeOrigin(input.target.site), username: input.target.username ?? null, url };
    approver = who.principalUserId;
  } else {
    const wanted = input.target.connector;
    const row = await first<ConnectorRow>(db, "SELECT * FROM connectors WHERE workspace_id = ? AND (id = ? OR name = ? COLLATE NOCASE)", ctx.wsId, wanted, wanted);
    if (!row || (who.perms[`connector:${row.id}`] ?? "none") === "none") throw notFound(`${agent.name} não tem um conector chamado "${wanted}".`);
    if (row.auth === "oauth") throw badRequest(`${row.name} usa login pelo site. Peça para a pessoa refazer o login em Configurações › Conectores.`);
    if (!singleSecretSlot(await connectorSecrets(ctx, row))) {
      throw badRequest(`${row.name} não tem um único token para trocar. Peça para a pessoa ajustar em Configurações › Conectores.`);
    }
    target = { target: "connector", connectorId: row.id, name: row.name, url };
    // Só quem conectou pode mudar a credencial do conector.
    approver = row.owner_user_id;
  }

  const approval: ApprovalRow = {
    id: newId(),
    workspace_id: ctx.wsId,
    agent_id: agent.id,
    job_id: job.id,
    kind: "secret",
    title: input.label,
    details: input.reason,
    approver_user_id: approver,
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: Date.now(),
    secret_target: JSON.stringify(target),
  };
  await run(
    db,
    `INSERT INTO approvals (id, workspace_id, agent_id, job_id, kind, title, details, approver_user_id, status, created_at, secret_target)
     VALUES (?, ?, ?, ?, 'secret', ?, ?, ?, 'pending', ?, ?)`,
    approval.id,
    approval.workspace_id,
    approval.agent_id,
    approval.job_id,
    approval.title,
    approval.details,
    approval.approver_user_id,
    approval.created_at,
    approval.secret_target!,
  );
  const dto = await publishApproval(ctx, approval);
  await notify(ctx, { userId: approver, kind: "approval", title: `${agent.name} pediu um dado sigiloso`, body: approval.title, link: links.approvals(ctx.wsId) });
  return dto;
}

async function storeVault(ctx: HubCtx, userId: string, t: Extract<SecretTargetDTO, { target: "vault" }>, secret: string, username: string | undefined) {
  const db = ctx.env.DB;
  const user = username ?? t.username;
  if (!user) throw badRequest("Informe o usuário deste login.");
  const enc = await encryptJson(ctx.env.SECRETS_KEY, { password: secret });
  const now = Date.now();
  const existing = await first<{ id: string }>(db, "SELECT id FROM vault_items WHERE workspace_id = ? AND owner_user_id = ? AND name = ? COLLATE NOCASE", ctx.wsId, userId, t.name);
  if (existing) {
    await run(db, "UPDATE vault_items SET origin = ?, username = ?, secret_enc = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", t.origin, user, enc, now, ctx.wsId, existing.id);
  } else {
    await run(
      db,
      "INSERT INTO vault_items (id, workspace_id, owner_user_id, name, origin, username, secret_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      newId(),
      ctx.wsId,
      userId,
      t.name,
      t.origin,
      user,
      enc,
      now,
      now,
    );
  }
}

async function storeConnector(ctx: HubCtx, userId: string, t: Extract<SecretTargetDTO, { target: "connector" }>, secret: string) {
  const db = ctx.env.DB;
  const row = await first<ConnectorRow>(db, "SELECT * FROM connectors WHERE workspace_id = ? AND id = ?", ctx.wsId, t.connectorId);
  if (!row) throw notFound("O conector deste pedido não existe mais.");
  if (row.owner_user_id !== userId) throw forbidden("Só quem conectou pode mudar este conector.", "connector_owner_required");
  const current = await connectorSecrets(ctx, row);
  const slot = singleSecretSlot(current);
  if (!slot || row.auth === "oauth") throw conflict("O conector mudou desde o pedido. Ajuste em Configurações › Conectores.", "connector_changed");
  const enc = await encryptJson(ctx.env.SECRETS_KEY, replaceSecret(current, slot, secret));
  await run(db, "UPDATE connectors SET secrets_enc = ? WHERE workspace_id = ? AND id = ?", enc, ctx.wsId, row.id);
}

/**
 * Resposta da pessoa. Só quem recebeu o pedido responde (nem admin): o valor entra no cofre ou no conector
 * dela. O segredo é guardado antes de o pedido mudar de estado; a resposta e o evento não o carregam.
 */
export async function answerSecretRequest(
  ctx: HubCtx,
  approval: ApprovalRow,
  userId: string,
  body: { decision: "approved" | "rejected"; secret?: string; username?: string },
): Promise<ApprovalDTO> {
  const db = ctx.env.DB;
  if (approval.approver_user_id !== userId) throw forbidden("Só quem recebeu este pedido pode responder.");
  if (approval.status !== "pending") throw conflict("Este pedido já foi respondido.", "approval_decided");
  if (body.decision === "approved") {
    if (!body.secret) throw badRequest("Digite o valor para guardar.");
    let target: SecretTargetDTO;
    try {
      target = JSON.parse(approval.secret_target ?? "") as SecretTargetDTO;
    } catch {
      throw conflict("Este pedido está incompleto. Recuse e peça de novo.", "secret_request_invalid");
    }
    if (target.target === "vault") await storeVault(ctx, userId, target, body.secret, body.username);
    else await storeConnector(ctx, userId, target, body.secret);
  }
  const now = Date.now();
  const changed = await run(
    db,
    "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE workspace_id = ? AND id = ? AND status = 'pending'",
    body.decision,
    userId,
    now,
    ctx.wsId,
    approval.id,
  );
  if (changed === 0) throw conflict("Este pedido já foi respondido.", "approval_decided");
  return publishApproval(ctx, { ...approval, status: body.decision, decided_by: userId, decided_at: now });
}
