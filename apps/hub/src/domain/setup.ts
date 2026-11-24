/**
 * Agente criador: conversa com a pessoa, propõe a estrutura do time (plano) e o hub cria tudo de uma vez
 * depois que ela revisa. O agente nunca cria nada: só entrega o plano por `propor_estrutura`.
 *
 * Aplicar um plano só acrescenta. O que já existe com o mesmo nome é reaproveitado ou pulado, nunca
 * alterado nem apagado. Os conectores não são criados aqui (precisam de credencial, que não passa pelo
 * chat): o resultado diz quais faltam e para quais agentes, e a tela guia cada conexão.
 */
import { catalogApp, setupPlanSchema, type AgentDTO, type SetupApplyResult, type SetupPlan, type SetupPlanDTO } from "@puxibot/shared";
import { all, first, newId, parseJson, run, stmt } from "../lib/db";
import { badRequest } from "../lib/errors";
import { cronProblem } from "../lib/cron";
import { userActor } from "./actor";
import { createAgent, publishAgent, uniqueHandle, slugify } from "./agents";
import { addChannelMemberStmt, canSeeChannel, findOrCreateDm, publishChannel } from "./channels";
import type { HubCtx } from "./context";
import { createMemory } from "./memories";
import { DEFAULT_TIMEZONE, insertRoutine } from "./routines";
import type { AgentRow, ChannelRow } from "./rows";
import { createPage, findPageByTitle } from "./wiki";

export interface SetupPlanRow {
  id: string;
  workspace_id: string;
  user_id: string;
  agent_id: string;
  job_id: string | null;
  plan_json: string;
  status: SetupPlanDTO["status"];
  result_json: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}

export function toSetupPlanDTO(r: SetupPlanRow): SetupPlanDTO {
  return {
    id: r.id,
    status: r.status,
    plan: parseJson<SetupPlan>(r.plan_json, { summary: "", channels: [], agents: [], skills: [], routines: [], wikiPages: [], memories: [], connectors: [] }),
    result: parseJson<SetupApplyResult | null>(r.result_json, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const BUILDER_PERMS: Record<string, "none" | "read" | "write"> = { messages: "read", agents: "read", memory: "none", tasks: "none", wiki: "read", drive: "none" };

/** Agente criador da pessoa (um por pessoa em cada workspace) e a DM com ele. */
export async function ensureBuilder(ctx: HubCtx, userId: string): Promise<{ agent: AgentDTO; channelId: string }> {
  const db = ctx.env.DB;
  let row = await first<AgentRow>(db, "SELECT * FROM agents WHERE workspace_id = ? AND owner_user_id = ? AND system_kind = 'builder'", ctx.wsId, userId);
  if (!row) {
    const user = await first<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", userId);
    const firstName = (user?.name ?? "").trim().split(/\s+/)[0] ?? "";
    const handle = await uniqueHandle(db, ctx.wsId, `criador-${slugify(firstName, 16) || "time"}`);
    const created = await createAgent(ctx, {
      handle,
      name: "Criador",
      role: "Monta a estrutura do time",
      description: "Entende como o seu trabalho funciona e propõe canais, agentes, rotinas e conexões. Você revisa e cria com um clique.",
      instructions: "",
      ownerUserId: userId,
      accessMode: "owner",
      avatarColor: "#0ea5e9",
    });
    await db.batch([
      stmt(db, "UPDATE agents SET system_kind = 'builder', learn_skills = 0, agents_can_consult = 0, callable_agents_mode = 'none' WHERE workspace_id = ? AND id = ?", ctx.wsId, created.id),
      ...Object.entries(BUILDER_PERMS).map(([tool, level]) =>
        stmt(db, "INSERT INTO agent_tool_perms (agent_id, tool, level) VALUES (?, ?, ?) ON CONFLICT (agent_id, tool) DO UPDATE SET level = excluded.level", created.id, tool, level),
      ),
    ]);
    row = (await first<AgentRow>(db, "SELECT * FROM agents WHERE workspace_id = ? AND id = ?", ctx.wsId, created.id))!;
  }
  const { channel } = await findOrCreateDm(db, ctx.wsId, { type: "user", id: userId }, { type: "agent", id: row.id }, userId);
  return { agent: await publishAgent(ctx, row.id), channelId: channel.id };
}

/** Plano mais recente da pessoa que ainda interessa: o rascunho, ou o último aplicado. */
export async function currentPlan(db: D1Database, wsId: string, userId: string): Promise<SetupPlanRow | null> {
  return first<SetupPlanRow>(
    db,
    "SELECT * FROM setup_plans WHERE workspace_id = ? AND user_id = ? AND status <> 'discarded' ORDER BY (status = 'draft') DESC, updated_at DESC LIMIT 1",
    wsId,
    userId,
  );
}

/** Confere o que o esquema não cobre: referências internas, repetições e horários. Lança 400 com o que corrigir. */
export function validatePlan(raw: unknown): SetupPlan {
  const parsed = setupPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`Plano inválido em ${issue?.path.join(".") || "(raiz)"}: ${issue?.message ?? "formato"}`);
  }
  const plan = parsed.data;
  const dup = (items: string[], what: string) => {
    const seen = new Set<string>();
    for (const i of items.map((x) => x.toLowerCase())) {
      if (seen.has(i)) throw badRequest(`Plano inválido: ${what} repetido ("${i}").`);
      seen.add(i);
    }
  };
  dup(plan.channels.map((c) => c.name), "canal");
  dup(plan.agents.map((a) => a.handle), "handle de agente");
  dup(plan.skills.map((s) => s.name), "skill");
  dup(plan.wikiPages.map((w) => w.title), "página da wiki");
  dup(plan.connectors.map((c) => c.catalogId ?? c.name), "conector");
  const handles = new Set(plan.agents.map((a) => a.handle));
  const skills = new Set(plan.skills.map((s) => s.name.toLowerCase()));
  const connectors = new Set(plan.connectors.flatMap((c) => [c.catalogId, c.name].filter((x): x is string => !!x).map((x) => x.toLowerCase())));
  for (const a of plan.agents) {
    for (const s of a.skills) if (!skills.has(s.toLowerCase())) throw badRequest(`Plano inválido: o agente @${a.handle} usa a skill "${s}", que não está em skills.`);
    for (const c of a.connectors) if (!connectors.has(c.toLowerCase())) throw badRequest(`Plano inválido: o agente @${a.handle} usa o conector "${c}", que não está em connectors.`);
  }
  for (const r of plan.routines) {
    if (!handles.has(r.agent)) throw badRequest(`Plano inválido: a rotina "${r.name}" é de @${r.agent}, que não está em agents.`);
    const problem = cronProblem(r.cron, r.timezone ?? DEFAULT_TIMEZONE);
    if (problem) throw badRequest(`Plano inválido: rotina "${r.name}": ${problem}`);
  }
  for (const c of plan.connectors) if (c.catalogId && !catalogApp(c.catalogId)) throw badRequest(`Plano inválido: "${c.catalogId}" não está no catálogo; para um serviço fora dele, deixe catalogId vazio.`);
  if (plan.agents.length + plan.channels.length + plan.routines.length + plan.wikiPages.length + plan.skills.length === 0) {
    throw badRequest("Plano vazio: proponha ao menos um agente, canal, rotina, skill ou página.");
  }
  return plan;
}

/** Grava (ou substitui) o rascunho da pessoa e avisa a tela dela. */
export async function saveDraft(ctx: HubCtx, input: { userId: string; agentId: string; jobId: string | null; plan: SetupPlan }): Promise<SetupPlanDTO> {
  const db = ctx.env.DB;
  const now = Date.now();
  const existing = await first<SetupPlanRow>(db, "SELECT * FROM setup_plans WHERE workspace_id = ? AND user_id = ? AND status = 'draft'", ctx.wsId, input.userId);
  const json = JSON.stringify(input.plan);
  let id = existing?.id;
  if (id) {
    await run(db, "UPDATE setup_plans SET plan_json = ?, agent_id = ?, job_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", json, input.agentId, input.jobId, now, ctx.wsId, id);
  } else {
    id = newId();
    await run(
      db,
      "INSERT INTO setup_plans (id, workspace_id, user_id, agent_id, job_id, plan_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
      id,
      ctx.wsId,
      input.userId,
      input.agentId,
      input.jobId,
      json,
      now,
      now,
    );
  }
  const dto = toSetupPlanDTO((await first<SetupPlanRow>(db, "SELECT * FROM setup_plans WHERE workspace_id = ? AND id = ?", ctx.wsId, id))!);
  await ctx.rt.publish({ type: "setup.plan.upserted", plan: dto }, [input.userId]);
  return dto;
}

/**
 * Cria o que o plano descreve. Ordem: canais, skills, agentes (com skills e canais), rotinas, wiki,
 * memórias; por fim, conectores que a pessoa já tem são liberados e os que faltam viram pendência.
 */
export async function applyPlan(ctx: HubCtx, row: SetupPlanRow, userId: string, isAdmin: boolean): Promise<SetupPlanDTO> {
  const db = ctx.env.DB;
  const plan = validatePlan(parseJson<unknown>(row.plan_json, null));
  const now = Date.now();
  const result: SetupApplyResult = {
    created: { channels: [], agents: [], skills: [], routines: [], wikiPages: [], memories: 0 },
    skipped: [],
    pendingConnectors: [],
  };
  const skip = (kind: SetupApplyResult["skipped"][number]["kind"], name: string, reason: string) => result.skipped.push({ kind, name, reason });

  // Canais: os do plano e os que só aparecem nos agentes ou nas rotinas.
  const wanted = new Map(plan.channels.map((c) => [c.name, c]));
  for (const name of [...plan.agents.flatMap((a) => a.channels), ...plan.routines.map((r) => r.channel).filter((x): x is string => !!x)]) {
    if (!wanted.has(name)) wanted.set(name, { name });
  }
  const channels = new Map<string, ChannelRow>();
  for (const ch of wanted.values()) {
    let existing = await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name = ?", ctx.wsId, ch.name);
    if (existing) {
      if (!(await canSeeChannel(db, existing, userId))) {
        skip("channel", ch.name, "já existe um canal privado com esse nome");
        continue;
      }
      if (plan.channels.some((c) => c.name === ch.name)) skip("channel", ch.name, "já existia; foi reaproveitado");
    } else {
      const id = newId();
      await db.batch([
        stmt(
          db,
          `INSERT INTO channels (id, workspace_id, kind, name, section, topic, humans_only, is_private, dm_key, created_by, created_at, last_message_at)
           VALUES (?, ?, 'channel', ?, ?, ?, 0, 0, NULL, ?, ?, NULL)`,
          id,
          ctx.wsId,
          ch.name,
          ch.section ?? null,
          ch.topic ?? null,
          userId,
          now,
        ),
        addChannelMemberStmt(db, id, { type: "user", id: userId }, now),
      ]);
      existing = (await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND id = ?", ctx.wsId, id))!;
      result.created.channels.push(ch.name);
    }
    channels.set(ch.name, existing);
  }

  // Skills.
  const skillIds = new Map<string, string>();
  for (const s of plan.skills) {
    const existing = await first<{ id: string }>(db, "SELECT id FROM skills WHERE workspace_id = ? AND kind <> 'learned' AND name = ? COLLATE NOCASE", ctx.wsId, s.name);
    if (existing) {
      skillIds.set(s.name.toLowerCase(), existing.id);
      skip("skill", s.name, "já existia; foi reaproveitada");
      continue;
    }
    const id = newId();
    await run(
      db,
      "INSERT INTO skills (id, workspace_id, name, description, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      ctx.wsId,
      s.name,
      s.description,
      s.body,
      userId,
      now,
      now,
    );
    skillIds.set(s.name.toLowerCase(), id);
    result.created.skills.push(s.name);
  }

  // Agentes.
  const agentIds = new Map<string, { id: string; name: string }>();
  for (const a of plan.agents) {
    if (await first(db, "SELECT 1 AS one FROM agents WHERE workspace_id = ? AND handle = ?", ctx.wsId, a.handle)) {
      skip("agent", `@${a.handle}`, "já existe um agente com esse @; nada nele foi alterado");
      continue;
    }
    const dto = await createAgent(ctx, { handle: a.handle, name: a.name, role: a.role ?? null, description: a.description ?? null, instructions: a.instructions, ownerUserId: userId });
    const statements = [
      ...a.skills.map((s) => skillIds.get(s.toLowerCase())).filter((x): x is string => !!x).map((sid) => stmt(db, "INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)", dto.id, sid)),
      ...a.channels
        .map((n) => channels.get(n))
        .filter((ch): ch is ChannelRow => !!ch && ch.humans_only === 0)
        .map((ch) => addChannelMemberStmt(db, ch.id, { type: "agent", id: dto.id }, now)),
    ];
    if (statements.length) await db.batch(statements);
    agentIds.set(a.handle, { id: dto.id, name: a.name });
    result.created.agents.push(`@${a.handle}`);
  }
  for (const ch of channels.values()) await publishChannel(ctx, ch);

  // Rotinas: só para agentes criados agora.
  for (const r of plan.routines) {
    const agent = agentIds.get(r.agent);
    if (!agent) {
      skip("routine", r.name, `o agente @${r.agent} não foi criado`);
      continue;
    }
    const channel = r.channel ? channels.get(r.channel) : undefined;
    if (r.channel && (!channel || channel.humans_only === 1)) {
      skip("routine", r.name, `o canal #${r.channel} não está disponível para o agente`);
      continue;
    }
    await insertRoutine(db, ctx.wsId, {
      agentId: agent.id,
      name: r.name,
      prompt: r.prompt,
      cron: r.cron,
      timezone: r.timezone ?? DEFAULT_TIMEZONE,
      channelId: channel?.id ?? null,
      enabled: true,
      kind: "custom",
      createdBy: userId,
    });
    result.created.routines.push(r.name);
  }

  // Wiki e memórias do time: quem assina é a pessoa, que revisou e aprovou o texto.
  const actor = userActor(userId, isAdmin);
  for (const w of plan.wikiPages) {
    if (await findPageByTitle(db, ctx.wsId, w.title)) {
      skip("wikiPage", w.title, "já existe uma página com esse título; nada nela foi alterado");
      continue;
    }
    await createPage(ctx, actor, { title: w.title, body: w.body, note: "Criada pelo agente criador, aprovada na revisão do plano." });
    result.created.wikiPages.push(w.title);
  }
  const knownMemories = new Set((await all<{ content: string }>(db, "SELECT content FROM memories WHERE workspace_id = ? AND scope = 'team'", ctx.wsId)).map((m) => m.content.trim().toLowerCase()));
  for (const content of plan.memories) {
    if (knownMemories.has(content.trim().toLowerCase())) {
      skip("memory", content.slice(0, 60), "já estava na memória do time");
      continue;
    }
    knownMemories.add(content.trim().toLowerCase());
    await createMemory(db, ctx.wsId, actor, { scope: "team", agentId: null, content, source: "user", status: "confirmed" });
    result.created.memories += 1;
  }

  // Conectores: libera os que a pessoa já tem; o resto fica pendente para a tela guiar.
  for (const c of plan.connectors) {
    const users = plan.agents
      .filter((a) => a.connectors.some((x) => x.toLowerCase() === (c.catalogId ?? "").toLowerCase() || x.toLowerCase() === c.name.toLowerCase()))
      .map((a) => agentIds.get(a.handle))
      .filter((x): x is { id: string; name: string } => !!x);
    const mine = c.catalogId
      ? await first<{ id: string }>(db, "SELECT id FROM connectors WHERE workspace_id = ? AND owner_user_id = ? AND catalog_id = ?", ctx.wsId, userId, c.catalogId)
      : await first<{ id: string }>(db, "SELECT id FROM connectors WHERE workspace_id = ? AND owner_user_id = ? AND name = ? COLLATE NOCASE", ctx.wsId, userId, c.name);
    if (mine && users.length) await grantConnector(ctx, mine.id, users.map((u) => u.id));
    result.pendingConnectors.push({
      catalogId: c.catalogId ?? null,
      name: c.catalogId ? (catalogApp(c.catalogId)?.displayName ?? c.name) : c.name,
      reason: c.reason,
      agentIds: users.map((u) => u.id),
      agentNames: users.map((u) => u.name),
      connectorId: mine?.id ?? null,
    });
  }

  await run(db, "UPDATE setup_plans SET status = 'applied', result_json = ?, applied_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", JSON.stringify(result), now, now, ctx.wsId, row.id);
  await ctx.rt.pump();
  const dto = toSetupPlanDTO((await first<SetupPlanRow>(db, "SELECT * FROM setup_plans WHERE workspace_id = ? AND id = ?", ctx.wsId, row.id))!);
  await ctx.rt.publish({ type: "setup.plan.upserted", plan: dto }, [userId]);
  return dto;
}

/**
 * Libera um conector para agentes, com acesso a leitura e ações. As ações continuam passando pela
 * checagem de permissão do hub; quem conectou pode reduzir para somente leitura no perfil do agente.
 */
export async function grantConnector(ctx: HubCtx, connectorId: string, agentIds: string[]): Promise<void> {
  const db = ctx.env.DB;
  const tool = `connector:${connectorId}`;
  for (const agentId of new Set(agentIds)) {
    const agent = await first<{ id: string }>(db, "SELECT id FROM agents WHERE workspace_id = ? AND id = ?", ctx.wsId, agentId);
    if (!agent) continue;
    // Não reduz um acesso que alguém já tenha configurado.
    await run(db, "INSERT OR IGNORE INTO agent_tool_perms (agent_id, tool, level) VALUES (?, ?, 'write')", agentId, tool);
    await publishAgent(ctx, agentId);
  }
}
