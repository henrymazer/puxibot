/**
 * Agente criador. Rotas do workspace: abrir a conversa com ele, ler e editar o plano, criar tudo ou
 * descartar. Rotas de ferramenta (token de job): só o agente criador as usa, para ver o catálogo e
 * entregar o plano.
 */
import { Hono, type Context } from "hono";
import { CATALOG, type SetupSessionDTO } from "@puxibot/shared";
import { all, first, run } from "../lib/db";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../lib/errors";
import { readTextLimited } from "../lib/validate";
import { isAdmin } from "../http/auth";
import type { ToolEnv, WsEnv } from "../http/types";
import { jobPrincipal } from "../domain/actor";
import { requireAgentRow } from "../domain/agents";
import { getJobRow } from "../domain/jobs";
import { applyPlan, currentPlan, ensureBuilder, saveDraft, toSetupPlanDTO, validatePlan, type SetupPlanRow } from "../domain/setup";

export const setupRoutes = new Hono<WsEnv>();

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return JSON.parse((await readTextLimited(c)) || "null");
  } catch {
    throw badRequest("O corpo precisa ser JSON.");
  }
}

async function session(c: Context<WsEnv>): Promise<SetupSessionDTO> {
  const { agent, channelId } = await ensureBuilder(c.get("hub"), c.get("userId"));
  const plan = await currentPlan(c.env.DB, c.get("wsId"), c.get("userId"));
  return { agentId: agent.id, channelId, plan: plan ? toSetupPlanDTO(plan) : null };
}

/** Abre (ou retoma) a conversa com o agente criador. Idempotente. */
setupRoutes.post("/setup/session", async (c) => c.json(await session(c)));

setupRoutes.get("/setup/plan", async (c) => {
  const plan = await currentPlan(c.env.DB, c.get("wsId"), c.get("userId"));
  return c.json({ plan: plan ? toSetupPlanDTO(plan) : null });
});

async function ownDraft(c: Context<WsEnv>): Promise<SetupPlanRow> {
  const row = await first<SetupPlanRow>(c.env.DB, "SELECT * FROM setup_plans WHERE workspace_id = ? AND id = ? AND user_id = ?", c.get("wsId"), c.req.param("id")!, c.get("userId"));
  if (!row) throw notFound("Plano não encontrado.");
  if (row.status !== "draft") throw conflict(row.status === "applied" ? "Este plano já foi criado." : "Este plano foi descartado.", "plan_not_draft");
  return row;
}

/** A pessoa ajusta o plano na tela antes de criar. */
setupRoutes.put("/setup/plans/:id", async (c) => {
  const row = await ownDraft(c);
  const plan = validatePlan(await jsonBody(c));
  return c.json(await saveDraft(c.get("hub"), { userId: c.get("userId"), agentId: row.agent_id, jobId: row.job_id, plan }));
});

setupRoutes.post("/setup/plans/:id/apply", async (c) => {
  const row = await ownDraft(c);
  // Trava contra dois cliques: só um pedido sai de 'draft'.
  const claimed = await run(c.env.DB, "UPDATE setup_plans SET status = 'applied' WHERE workspace_id = ? AND id = ? AND status = 'draft'", c.get("wsId"), row.id);
  if (claimed === 0) throw conflict("Este plano já está sendo criado.", "plan_not_draft");
  try {
    return c.json(await applyPlan(c.get("hub"), row, c.get("userId"), isAdmin(c)));
  } catch (err) {
    await run(c.env.DB, "UPDATE setup_plans SET status = 'draft' WHERE workspace_id = ? AND id = ? AND result_json IS NULL", c.get("wsId"), row.id);
    throw err;
  }
});

setupRoutes.post("/setup/plans/:id/discard", async (c) => {
  const row = await ownDraft(c);
  await run(c.env.DB, "UPDATE setup_plans SET status = 'discarded', updated_at = ? WHERE workspace_id = ? AND id = ?", Date.now(), c.get("wsId"), row.id);
  return c.body(null, 204);
});

// ---------- Ferramentas do agente criador ----------
export const setupToolRoutes = new Hono<ToolEnv>();

async function builderCtx(c: Context<ToolEnv>) {
  const claims = c.get("job");
  const [agent, job] = await Promise.all([requireAgentRow(c.env.DB, claims.workspaceId, claims.agentId), getJobRow(c.env.DB, claims.workspaceId, claims.jobId)]);
  if (!job) throw new HttpError(401, "unauthorized", "Este job não existe mais.");
  if (agent.system_kind !== "builder") throw forbidden("Só o agente criador usa esta ferramenta.", "builder_only");
  return { agent, job, wsId: claims.workspaceId, userId: jobPrincipal(job, agent) };
}

setupToolRoutes.get("/setup/catalog", async (c) => {
  const t = await builderCtx(c);
  const connected = await all<{ name: string; catalog_id: string | null }>(c.env.DB, "SELECT name, catalog_id FROM connectors WHERE workspace_id = ? ORDER BY name COLLATE NOCASE", t.wsId);
  return c.json({
    catalogo: CATALOG.map((a) => ({ catalogId: a.id, nome: a.displayName, paraQueServe: a.description, categorias: a.categories, requisitos: a.requirements, limites: a.limitations, exemplos: a.prompts })),
    jaConectados: connected.map((x) => ({ nome: x.name, catalogId: x.catalog_id })),
    nota: "Para um serviço fora do catálogo, proponha o conector só com `name` (sem catalogId): a pessoa informa o endereço do servidor MCP dele na tela.",
  });
});

setupToolRoutes.post("/setup/plan", async (c) => {
  const t = await builderCtx(c);
  const plan = validatePlan(await jsonBody(c));
  const dto = await saveDraft(c.get("hub"), { userId: t.userId, agentId: t.agent.id, jobId: t.job.id, plan });
  return c.json({
    ok: true,
    planId: dto.id,
    nota: "Plano entregue. A pessoa revisa e cria pela tela; você não precisa (nem consegue) criar nada. Resuma o plano na resposta em poucas linhas.",
  });
});
