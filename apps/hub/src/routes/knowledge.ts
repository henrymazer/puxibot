import { Hono, type Context } from "hono";
import { z } from "zod";
import { CATALOG, CONNECTOR_AUTH_METHODS, catalogApp } from "@puxibot/shared";
import { all, first, newId, run } from "../lib/db";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { decryptJson, encryptJson } from "../lib/crypto";
import { readBody } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { WsEnv } from "../http/types";
import { userActor } from "../domain/actor";
import { publishAgent, requireAgentRow } from "../domain/agents";
import { assertPublicHttps, beginOAuth, oauthCallbackUrl } from "../domain/connectorOauth";
import { grantConnector } from "../domain/setup";
import { confirmMemory, createMemory, deleteMemory, getMemory, listMemories, updateMemory } from "../domain/memories";
import { toConnectorDTO, toSkillDTO, type AgentRow, type ConnectorRow, type SkillRow } from "../domain/rows";

/** Memórias (individual e do time), skills e conectores. */
export const knowledgeRoutes = new Hono<WsEnv>();

const contentSchema = z.object({ content: z.string().trim().min(1).max(5000) });

function canManageAgent(c: Context<WsEnv>, agent: AgentRow) {
  return agent.owner_user_id === c.get("userId") || isAdmin(c);
}

// ---------- Memória individual do agente ----------
// Leitura: qualquer membro (exceto memória do assistente pessoal de outra pessoa). Escrita: responsável ou admin.
async function agentForMemory(c: Context<WsEnv>, write: boolean): Promise<AgentRow> {
  const agent = await requireAgentRow(c.env.DB, c.get("wsId"), c.req.param("id")!);
  if (agent.is_assistant === 1 && agent.owner_user_id !== c.get("userId")) throw notFound("Agente não encontrado.");
  if (write && !canManageAgent(c, agent)) throw forbidden("Só o responsável pelo agente ou um admin muda a memória dele.");
  return agent;
}

knowledgeRoutes.get("/agents/:id/memories", async (c) => {
  const agent = await agentForMemory(c, false);
  return c.json({ items: await listMemories(c.env.DB, c.get("wsId"), { scope: "agent", agentId: agent.id, q: c.req.query("q") || undefined }) });
});

knowledgeRoutes.post("/agents/:id/memories", async (c) => {
  const agent = await agentForMemory(c, true);
  const { content } = await readBody(c, contentSchema);
  const dto = await createMemory(c.env.DB, c.get("wsId"), userActor(c.get("userId"), isAdmin(c)), {
    scope: "agent",
    agentId: agent.id,
    content,
    source: "user",
  });
  return c.json(dto, 201);
});

async function requireAgentMemory(c: Context<WsEnv>, agent: AgentRow) {
  const row = await getMemory(c.env.DB, c.get("wsId"), c.req.param("mid")!);
  if (!row || row.scope !== "agent" || row.agent_id !== agent.id) throw notFound("Memória não encontrada.");
  return row;
}

knowledgeRoutes.patch("/agents/:id/memories/:mid", async (c) => {
  const agent = await agentForMemory(c, true);
  const row = await requireAgentMemory(c, agent);
  const { content } = await readBody(c, contentSchema);
  return c.json(await updateMemory(c.env.DB, c.get("wsId"), row, content));
});

// Confirma uma memória que um agente gravou sem citação conferida.
knowledgeRoutes.post("/agents/:id/memories/:mid/confirm", async (c) => {
  const agent = await agentForMemory(c, true);
  return c.json(await confirmMemory(c.env.DB, c.get("wsId"), await requireAgentMemory(c, agent)));
});

knowledgeRoutes.delete("/agents/:id/memories/:mid", async (c) => {
  const agent = await agentForMemory(c, true);
  const row = await requireAgentMemory(c, agent);
  await deleteMemory(c.env.DB, c.get("wsId"), row.id);
  return c.body(null, 204);
});

// ---------- Memória do time (qualquer membro lê e edita) ----------
knowledgeRoutes.get("/memories", async (c) =>
  c.json({ items: await listMemories(c.env.DB, c.get("wsId"), { scope: "team", q: c.req.query("q") || undefined }) }),
);

knowledgeRoutes.post("/memories", async (c) => {
  const { content } = await readBody(c, contentSchema);
  const dto = await createMemory(c.env.DB, c.get("wsId"), userActor(c.get("userId"), isAdmin(c)), {
    scope: "team",
    agentId: null,
    content,
    source: "user",
  });
  return c.json(dto, 201);
});

async function requireTeamMemory(c: Context<WsEnv>) {
  const row = await getMemory(c.env.DB, c.get("wsId"), c.req.param("mid")!);
  if (!row || row.scope !== "team") throw notFound("Memória não encontrada.");
  return row;
}

knowledgeRoutes.patch("/memories/:mid", async (c) => {
  const row = await requireTeamMemory(c);
  const { content } = await readBody(c, contentSchema);
  return c.json(await updateMemory(c.env.DB, c.get("wsId"), row, content));
});

knowledgeRoutes.post("/memories/:mid/confirm", async (c) => c.json(await confirmMemory(c.env.DB, c.get("wsId"), await requireTeamMemory(c))));

knowledgeRoutes.delete("/memories/:mid", async (c) => {
  const row = await requireTeamMemory(c);
  await deleteMemory(c.env.DB, c.get("wsId"), row.id);
  return c.body(null, 204);
});

// ---------- Skills ----------
const skillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  body: z.string().min(1).max(100_000),
});

async function requireSkill(c: Context<WsEnv>): Promise<SkillRow> {
  const row = await first<SkillRow>(c.env.DB, "SELECT * FROM skills WHERE workspace_id = ? AND id = ?", c.get("wsId"), c.req.param("id")!);
  if (!row) throw notFound("Skill não encontrada.");
  return row;
}

knowledgeRoutes.get("/skills", async (c) => {
  const rows = await all<SkillRow>(c.env.DB, "SELECT * FROM skills WHERE workspace_id = ? ORDER BY name COLLATE NOCASE", c.get("wsId"));
  return c.json({ items: rows.map(toSkillDTO) });
});

knowledgeRoutes.post("/skills", async (c) => {
  const body = await readBody(c, skillSchema);
  const now = Date.now();
  const row: SkillRow = {
    id: newId(),
    workspace_id: c.get("wsId"),
    name: body.name,
    description: body.description,
    body: body.body,
    created_by: c.get("userId"),
    created_at: now,
    updated_at: now,
  };
  await run(
    c.env.DB,
    "INSERT INTO skills (id, workspace_id, name, description, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    row.id,
    row.workspace_id,
    row.name,
    row.description,
    row.body,
    row.created_by,
    row.created_at,
    row.updated_at,
  );
  return c.json(toSkillDTO(row), 201);
});

knowledgeRoutes.get("/skills/:id", async (c) => c.json(toSkillDTO(await requireSkill(c))));

function assertSkillWriter(c: Context<WsEnv>, row: SkillRow) {
  if (row.created_by !== c.get("userId") && !isAdmin(c)) throw forbidden("Só quem criou a skill ou um admin pode mudá-la.");
}

knowledgeRoutes.patch("/skills/:id", async (c) => {
  const row = await requireSkill(c);
  assertSkillWriter(c, row);
  const body = await readBody(c, skillSchema.partial());
  const next: SkillRow = { ...row, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), updated_at: Date.now() };
  await run(
    c.env.DB,
    "UPDATE skills SET name = ?, description = ?, body = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    next.name,
    next.description,
    next.body,
    next.updated_at,
    c.get("wsId"),
    row.id,
  );
  return c.json(toSkillDTO(next));
});

knowledgeRoutes.delete("/skills/:id", async (c) => {
  const row = await requireSkill(c);
  assertSkillWriter(c, row);
  const linked = await all<{ agent_id: string }>(c.env.DB, "SELECT agent_id FROM agent_skills WHERE skill_id = ?", row.id);
  await run(c.env.DB, "DELETE FROM skills WHERE workspace_id = ? AND id = ?", c.get("wsId"), row.id);
  for (const l of linked) await publishAgent(c.get("hub"), l.agent_id);
  return c.body(null, 204);
});

// ---------- Conectores ----------
// Segredos (`headers`, `env`) entram cifrados (AES-GCM, SECRETS_KEY) e nunca voltam: o GET mostra só os nomes.
const secretMap = z.record(z.string().min(1).max(200), z.string().max(10_000));
const connectorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  transport: z.enum(["http", "stdio"]),
  url: z.string().url().max(2000).nullable().optional(),
  command: z.string().max(500).nullable().optional(),
  args: z.array(z.string().max(2000)).max(50).default([]),
  headers: secretMap.optional(),
  env: secretMap.optional(),
  /** "oauth" = login pelo navegador (só conector http com endereço público). */
  auth: z.enum(["static", "oauth"]).optional(),
  oauthClientId: z.string().trim().max(300).nullable().optional(),
  oauthScope: z.string().trim().max(500).nullable().optional(),
});

/** Conexão a partir de um app do catálogo: o endereço vem da receita, nunca de quem pede. */
const catalogConnectSchema = z.object({
  catalogId: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80).optional(),
  method: z.enum(CONNECTOR_AUTH_METHODS),
  /** Para `bearer` e `x-api-key`. */
  token: z.string().min(1).max(10_000).optional(),
  /** Para `oauth2`, quando o app exige um cliente pré-registrado. */
  clientId: z.string().trim().min(1).max(300).optional(),
  /** Agentes que recebem acesso assim que o conector for criado (os que quem conecta administra). */
  grantAgentIds: z.array(z.string()).max(20).default([]),
});
type Secrets = { headers?: Record<string, string>; env?: Record<string, string> };

async function requireConnector(c: Context<WsEnv>): Promise<ConnectorRow> {
  const row = await first<ConnectorRow>(c.env.DB, "SELECT * FROM connectors WHERE workspace_id = ? AND id = ?", c.get("wsId"), c.req.param("id")!);
  if (!row) throw notFound("Conector não encontrado.");
  return row;
}

async function connectorDTO(c: Context<WsEnv>, row: ConnectorRow) {
  let names = { headers: [] as string[], env: [] as string[] };
  if (row.secrets_enc) {
    try {
      const s = await decryptJson<Secrets>(c.env.SECRETS_KEY, row.secrets_enc);
      names = { headers: Object.keys(s.headers ?? {}), env: Object.keys(s.env ?? {}) };
    } catch {
      // segredo ilegível (chave trocada): mostra sem nomes
    }
  }
  return toConnectorDTO(row, names);
}

function validateTransport(t: "http" | "stdio", url: string | null | undefined, command: string | null | undefined) {
  if (t === "http" && !url) throw badRequest("Conector http precisa de url.");
  if (t === "stdio" && !command) throw badRequest("Conector stdio precisa de command.");
}

function assertOAuthTarget(transport: string, url: string | null | undefined) {
  if (transport !== "http" || !url) throw badRequest("Login pelo navegador só funciona em conector http.");
  assertPublicHttps(url);
}

/** Só agentes que a pessoa administra recebem acesso junto com a criação do conector. */
async function manageableAgents(c: Context<WsEnv>, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of new Set(ids)) {
    const agent = await requireAgentRow(c.env.DB, c.get("wsId"), id);
    if (!canManageAgent(c, agent)) throw forbidden(`Você não administra ${agent.name}; peça ao responsável para liberar o conector para ele.`);
    out.push(agent.id);
  }
  return out;
}

knowledgeRoutes.get("/connectors/catalog", (c) => c.json({ items: CATALOG, callbackUrl: oauthCallbackUrl(c.env, new URL(c.req.url).origin) }));

knowledgeRoutes.post("/connectors/from-catalog", async (c) => {
  const body = await readBody(c, catalogConnectSchema);
  const app = catalogApp(body.catalogId);
  if (!app) throw notFound("App não encontrado no catálogo.");
  if (!app.authentication.includes(body.method)) throw badRequest(`${app.displayName} não aceita essa forma de conexão.`);
  const grant = await manageableAgents(c, body.grantAgentIds);
  const oauth = body.method === "oauth2";
  let secrets: Secrets = {};
  if (!oauth) {
    if (!body.token?.trim()) throw badRequest("Informe o token.");
    const token = body.token.trim();
    secrets = { headers: body.method === "bearer" ? { Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}` } : { [app.apiKeyHeader]: token } };
  } else if (app.clientIdRequired && !body.clientId) {
    throw badRequest(`${app.displayName} exige o id do seu app para o login pelo navegador.`);
  }
  const row: ConnectorRow = {
    id: newId(),
    workspace_id: c.get("wsId"),
    name: body.name ?? app.displayName,
    transport: "http",
    url: app.url,
    command: null,
    args_json: "[]",
    secrets_enc: oauth ? null : await encryptJson(c.env.SECRETS_KEY, secrets),
    owner_user_id: c.get("userId"),
    created_at: Date.now(),
    catalog_id: app.id,
    auth: oauth ? "oauth" : "static",
    oauth_enc: null,
    oauth_status: oauth ? "pending" : null,
    oauth_client_id: oauth ? (body.clientId ?? null) : null,
    oauth_scope: oauth && app.scopes.length ? app.scopes.join(" ") : null,
  };
  await insertConnector(c.env.DB, row);
  if (grant.length) await grantConnector(c.get("hub"), row.id, grant);
  return c.json(await connectorDTO(c, row), 201);
});

async function insertConnector(db: D1Database, row: ConnectorRow): Promise<void> {
  await run(
    db,
    `INSERT INTO connectors (id, workspace_id, name, transport, url, command, args_json, secrets_enc, owner_user_id, created_at,
       catalog_id, auth, oauth_enc, oauth_status, oauth_client_id, oauth_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.workspace_id,
    row.name,
    row.transport,
    row.url,
    row.command,
    row.args_json,
    row.secrets_enc,
    row.owner_user_id,
    row.created_at,
    row.catalog_id ?? null,
    row.auth ?? "static",
    row.oauth_enc ?? null,
    row.oauth_status ?? null,
    row.oauth_client_id ?? null,
    row.oauth_scope ?? null,
  );
}

/** Começa o login pelo navegador. A resposta traz o endereço da tela de consentimento do serviço. */
knowledgeRoutes.post("/connectors/:id/oauth/start", async (c) => {
  const row = await requireConnector(c);
  return c.json(await beginOAuth(c.env, row, c.get("userId"), new URL(c.req.url).origin));
});

/** Libera o conector para agentes que a pessoa administra (usado depois de conectar um app do plano). */
knowledgeRoutes.post("/connectors/:id/grant", async (c) => {
  const row = await requireConnector(c);
  if (row.owner_user_id !== c.get("userId")) throw forbidden("Só quem conectou pode conceder acesso a este conector.", "connector_owner_required");
  const { agentIds } = await readBody(c, z.object({ agentIds: z.array(z.string()).min(1).max(20) }));
  await grantConnector(c.get("hub"), row.id, await manageableAgents(c, agentIds));
  return c.json({ ok: true });
});

knowledgeRoutes.get("/connectors", async (c) => {
  const rows = await all<ConnectorRow>(c.env.DB, "SELECT * FROM connectors WHERE workspace_id = ? ORDER BY name COLLATE NOCASE", c.get("wsId"));
  return c.json({ items: await Promise.all(rows.map((r) => connectorDTO(c, r))) });
});

knowledgeRoutes.post("/connectors", async (c) => {
  const body = await readBody(c, connectorSchema);
  validateTransport(body.transport, body.url, body.command);
  const secrets: Secrets = {};
  if (body.headers && Object.keys(body.headers).length) secrets.headers = body.headers;
  if (body.env && Object.keys(body.env).length) secrets.env = body.env;
  const oauth = body.auth === "oauth";
  if (oauth) assertOAuthTarget(body.transport, body.url);
  const row: ConnectorRow = {
    id: newId(),
    workspace_id: c.get("wsId"),
    name: body.name,
    transport: body.transport,
    url: body.transport === "http" ? (body.url ?? null) : null,
    command: body.transport === "stdio" ? (body.command ?? null) : null,
    args_json: JSON.stringify(body.args),
    secrets_enc: Object.keys(secrets).length ? await encryptJson(c.env.SECRETS_KEY, secrets) : null,
    owner_user_id: c.get("userId"),
    created_at: Date.now(),
    catalog_id: null,
    auth: oauth ? "oauth" : "static",
    oauth_enc: null,
    oauth_status: oauth ? "pending" : null,
    oauth_client_id: oauth ? (body.oauthClientId ?? null) : null,
    oauth_scope: oauth ? (body.oauthScope ?? null) : null,
  };
  await insertConnector(c.env.DB, row);
  return c.json(await connectorDTO(c, row), 201);
});

knowledgeRoutes.get("/connectors/:id", async (c) => c.json(await connectorDTO(c, await requireConnector(c))));

knowledgeRoutes.patch("/connectors/:id", async (c) => {
  const row = await requireConnector(c);
  if (row.owner_user_id !== c.get("userId")) throw forbidden("Só quem conectou pode mudar este conector.", "connector_owner_required");
  const body = await readBody(c, connectorSchema.partial().extend({ args: z.array(z.string().max(2000)).max(50).optional() }));
  const transport = body.transport ?? row.transport;
  const next: ConnectorRow = {
    ...row,
    name: body.name ?? row.name,
    transport,
    url: transport === "http" ? (body.url !== undefined ? body.url : row.url) : null,
    command: transport === "stdio" ? (body.command !== undefined ? body.command : row.command) : null,
    args_json: body.args !== undefined ? JSON.stringify(body.args) : row.args_json,
  };
  validateTransport(transport, next.url, next.command);
  // Receita do catálogo: o endereço é o da receita. Mudar o endereço de um conector com login guardado
  // mandaria o acesso de um serviço para outro; nesse caso o login é descartado.
  if (row.catalog_id && (next.url !== row.url || next.transport !== row.transport)) throw badRequest("O endereço de um app do catálogo não pode ser mudado; remova e conecte de novo.");
  if (body.auth !== undefined) next.auth = body.auth;
  if (body.oauthClientId !== undefined) next.oauth_client_id = body.oauthClientId;
  if (body.oauthScope !== undefined) next.oauth_scope = body.oauthScope;
  if (next.auth === "oauth") {
    assertOAuthTarget(next.transport, next.url);
    if (next.url !== row.url || next.oauth_client_id !== row.oauth_client_id || row.auth !== "oauth") {
      next.oauth_enc = null;
      next.oauth_status = "pending";
    }
  } else {
    next.oauth_enc = null;
    next.oauth_status = null;
    next.oauth_client_id = null;
    next.oauth_scope = null;
  }
  if (body.headers !== undefined || body.env !== undefined) {
    // Substitui só o grupo enviado; o outro grupo é mantido.
    let current: Secrets = {};
    if (row.secrets_enc) current = await decryptJson<Secrets>(c.env.SECRETS_KEY, row.secrets_enc).catch(() => ({}));
    const merged: Secrets = {
      ...(body.headers !== undefined ? (Object.keys(body.headers).length ? { headers: body.headers } : {}) : current.headers ? { headers: current.headers } : {}),
      ...(body.env !== undefined ? (Object.keys(body.env).length ? { env: body.env } : {}) : current.env ? { env: current.env } : {}),
    };
    next.secrets_enc = Object.keys(merged).length ? await encryptJson(c.env.SECRETS_KEY, merged) : null;
  }
  await run(
    c.env.DB,
    `UPDATE connectors SET name = ?, transport = ?, url = ?, command = ?, args_json = ?, secrets_enc = ?,
       auth = ?, oauth_enc = ?, oauth_status = ?, oauth_client_id = ?, oauth_scope = ? WHERE workspace_id = ? AND id = ?`,
    next.name,
    next.transport,
    next.url,
    next.command,
    next.args_json,
    next.secrets_enc,
    next.auth ?? "static",
    next.oauth_enc ?? null,
    next.oauth_status ?? null,
    next.oauth_client_id ?? null,
    next.oauth_scope ?? null,
    c.get("wsId"),
    row.id,
  );
  return c.json(await connectorDTO(c, next));
});

knowledgeRoutes.delete("/connectors/:id", async (c) => {
  const row = await requireConnector(c);
  if (row.owner_user_id !== c.get("userId") && !isAdmin(c)) throw forbidden("Só quem conectou ou um admin remove o conector.");
  const tool = `connector:${row.id}`;
  const granted = await all<{ agent_id: string }>(
    c.env.DB,
    "SELECT p.agent_id FROM agent_tool_perms p JOIN agents a ON a.id = p.agent_id WHERE a.workspace_id = ? AND p.tool = ?",
    c.get("wsId"),
    tool,
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM agent_tool_perms WHERE tool = ? AND agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)",
    ).bind(tool, c.get("wsId")),
    c.env.DB.prepare("DELETE FROM connectors WHERE workspace_id = ? AND id = ?").bind(c.get("wsId"), row.id),
  ]);
  for (const g of granted) await publishAgent(c.get("hub"), g.agent_id);
  return c.body(null, 204);
});
