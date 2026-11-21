/** Rotinas, skills e conectores no modo demonstração. */
import type { ConnectorDTO, MessageDTO, RoutineDTO, SkillDTO } from "@puxibot/shared";
import { nextRun, validateCron } from "../../lib/cron";
import { HttpError, type DemoContext, type DemoDb } from "../backend";
import type { AreaDb } from "../seedAreas";

const DAY = 24 * 3600_000;

export function seedAutomation(base: DemoDb): Pick<AreaDb, "routines" | "skills" | "connectors"> {
  const now = Date.now();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  const r = (p: Omit<RoutineDTO, "nextRunAt" | "timezone"> & { timezone?: string }): RoutineDTO => ({
    timezone: tz,
    ...p,
    nextRunAt: p.enabled ? nextRun(p.cron, now, p.timezone ?? tz) : null,
  });
  const routines: RoutineDTO[] = [
    r({ id: "rt_1", agentId: "agt_theo", name: "Resumo de PRs e issues", prompt: "Liste os PRs abertos e as issues novas desde ontem, com o que precisa de revisão.", cron: "4 9 * * 1-5", channelId: "ch_dev", enabled: true, kind: "custom", lastRunAt: now - DAY }),
    r({ id: "rt_2", agentId: "agt_lia", name: "Posts da semana", prompt: "Rascunhe 3 posts para o Instagram da semana, com legenda e sugestão de imagem.", cron: "0 9 * * 1", channelId: "ch_campanhas", enabled: true, kind: "custom", lastRunAt: now - 4 * DAY }),
    r({ id: "rt_3", agentId: "agt_assist", name: "Resumo diário", prompt: "Resumo do dia: tarefas feitas, travadas e o que espera por mim.", cron: "0 9 * * *", channelId: "dm_assist", enabled: true, kind: "daily_summary", lastRunAt: now - 15 * 3600_000 }),
    r({ id: "rt_4", agentId: "agt_nina", name: "Conferir pagamentos", prompt: "Confira os pagamentos recebidos nas últimas 6 horas.", cron: "0 */6 * * *", channelId: null, enabled: false, kind: "custom", lastRunAt: now - 9 * DAY }),
  ];
  const skills: SkillDTO[] = [
    { id: "sk_1", name: "Revisar pull request", description: "Passo a passo para revisar um PR do time.", body: "1. Leia a descrição e a issue ligada.\n2. Rode os testes localmente.\n3. Comente nomes e casos de borda.\n4. Aprove só com testes passando.", updatedAt: now - 3 * DAY, createdBy: base.user.id },
    { id: "sk_2", name: "Tom de voz da marca", description: "Como escrever para os clientes do estúdio.", body: "- Frases curtas.\n- Nada de jargão.\n- Sempre um próximo passo claro.", updatedAt: now - 8 * DAY, createdBy: base.members[1]!.userId },
  ];
  const connectors: AreaDb["connectors"] = [
    { id: "con_github", name: "GitHub", transport: "http", url: "https://api.githubcopilot.com/mcp/", command: null, args: [], ownerUserId: base.user.id, hasSecrets: true, secretHeaderNames: ["Authorization"], secretEnvNames: [], createdAt: now - 20 * DAY, secretHeaders: { Authorization: "Bearer ghp_demo" }, secretEnv: {} },
    { id: "con_gmail", name: "Gmail de Bruno", transport: "http", url: "https://gmail.example/mcp", command: null, args: [], ownerUserId: base.members[1]!.userId, hasSecrets: true, secretHeaderNames: ["Authorization"], secretEnvNames: [], createdAt: now - 12 * DAY, secretHeaders: { Authorization: "x" }, secretEnv: {} },
    { id: "con_fs", name: "Planilhas locais", transport: "stdio", url: null, command: "npx", args: ["-y", "@exemplo/mcp-planilhas"], ownerUserId: base.user.id, hasSecrets: false, secretHeaderNames: [], secretEnvNames: [], createdAt: now - 2 * DAY, secretHeaders: {}, secretEnv: {} },
  ];
  // Tito usa a skill de revisão.
  const tito = base.agents.find((a) => a.id === "agt_theo");
  if (tito) tito.skillIds = ["sk_1"];
  return { routines, skills, connectors };
}

export function registerAutomation(ctx: DemoContext): void {
  const { db, on, W } = ctx;
  const isAdmin = () => ctx.me().role !== "member";

  // ---------- Rotinas ----------
  const findRoutine = (id: string) => {
    const r = db.routines.find((x) => x.id === id);
    if (!r) throw new HttpError(404, "not_found", "Rotina não encontrada.");
    return r;
  };
  const canManage = (agentId: string) => {
    const a = db.agents.find((x) => x.id === agentId);
    if (!a) throw new HttpError(404, "not_found", "Agente não encontrado.");
    if (!isAdmin() && a.ownerUserId !== db.user.id) throw new HttpError(403, "forbidden", "Só o responsável pelo agente ou um admin muda as rotinas.");
    return a;
  };
  const refresh = (r: RoutineDTO) => {
    r.nextRunAt = r.enabled ? nextRun(r.cron, Date.now(), r.timezone) : null;
  };
  on("GET", `${W}/routines`, ({ query }) => {
    const ag = query.get("agentId");
    return { items: db.routines.filter((r) => !ag || r.agentId === ag) };
  });
  on(
    "POST",
    `${W}/routines`,
    ({ body }) => {
      canManage(body.agentId);
      if (!String(body.name ?? "").trim()) throw new HttpError(400, "invalid", "Dê um nome à rotina.");
      const err = validateCron(String(body.cron ?? ""));
      if (err) throw new HttpError(400, "invalid_cron", err);
      const r: RoutineDTO = {
        id: ctx.id("rt"),
        agentId: body.agentId,
        name: body.name,
        prompt: body.prompt ?? "",
        cron: body.cron,
        timezone: body.timezone || "America/Sao_Paulo",
        channelId: body.channelId ?? null,
        enabled: body.enabled ?? true,
        kind: "custom",
        nextRunAt: null,
        lastRunAt: null,
      };
      refresh(r);
      db.routines.push(r);
      return r;
    },
    201,
  );
  on("PATCH", `${W}/routines/:id`, async ({ m, body }) => {
    await ctx.sleep(120);
    const r = findRoutine(m[2]!);
    canManage(r.agentId);
    if (body.cron !== undefined) {
      const err = validateCron(String(body.cron));
      if (err) throw new HttpError(400, "invalid_cron", err);
    }
    for (const k of ["name", "prompt", "cron", "timezone", "channelId", "enabled"] as const) if (k in body) (r as unknown as Record<string, unknown>)[k] = body[k];
    refresh(r);
    return r;
  });
  on("DELETE", `${W}/routines/:id`, ({ m }) => {
    const r = findRoutine(m[2]!);
    canManage(r.agentId);
    if (r.kind === "daily_summary") throw new HttpError(400, "protected", "O resumo diário do assistente pode ser desligado, mas não apagado.");
    db.routines = db.routines.filter((x) => x.id !== r.id);
  });
  on("POST", `${W}/routines/:id/run`, ({ m }) => {
    const r = findRoutine(m[2]!);
    const agent = canManage(r.agentId);
    r.lastRunAt = Date.now();
    const trigger: MessageDTO = {
      id: `virtual_${r.id}_${Date.now()}`,
      channelId: r.channelId ?? "",
      author: { type: "system", id: null },
      body: r.prompt || r.name,
      threadRootId: null,
      replyCount: 0,
      quote: null,
      attachments: [],
      cards: [],
      mentions: [],
      reactions: [],
      jobId: null,
      meta: null,
      pinned: false,
      editedAt: null,
      deleted: false,
      createdAt: Date.now(),
    };
    void ctx.runJob(agent, trigger, { origin: "routine", routineId: r.id, requestedByUserId: null, channelId: r.channelId });
    return { ok: true };
  });

  // ---------- Skills ----------
  const findSkill = (id: string) => {
    const s = db.skills.find((x) => x.id === id);
    if (!s) throw new HttpError(404, "not_found", "Skill não encontrada.");
    return s;
  };
  const canEditSkill = (s: SkillDTO) => {
    if (!isAdmin() && s.createdBy && s.createdBy !== db.user.id) throw new HttpError(403, "forbidden", "Só quem criou a skill ou um admin muda.");
  };
  on("GET", `${W}/skills`, () => ({ items: db.skills }));
  on(
    "POST",
    `${W}/skills`,
    ({ body }) => {
      if (!String(body.name ?? "").trim()) throw new HttpError(400, "invalid", "Dê um nome à skill.");
      if (!String(body.body ?? "").trim()) throw new HttpError(400, "invalid_input", "Escreva as instruções da skill.");
      if (db.skills.some((s) => s.name.toLowerCase() === String(body.name).trim().toLowerCase())) throw new HttpError(409, "exists", "Já existe uma skill com esse nome.");
      const s: SkillDTO = { id: ctx.id("sk"), name: body.name.trim(), description: body.description ?? "", body: body.body ?? "", updatedAt: Date.now(), createdBy: db.user.id };
      db.skills.push(s);
      return s;
    },
    201,
  );
  on("PATCH", `${W}/skills/:id`, ({ m, body }) => {
    const s = findSkill(m[2]!);
    canEditSkill(s);
    for (const k of ["name", "description", "body"] as const) if (k in body) s[k] = body[k];
    s.updatedAt = Date.now();
    return s;
  });
  on("DELETE", `${W}/skills/:id`, ({ m }) => {
    const s = findSkill(m[2]!);
    canEditSkill(s);
    db.skills = db.skills.filter((x) => x.id !== s.id);
    for (const a of db.agents) if (a.skillIds.includes(s.id)) a.skillIds = a.skillIds.filter((x) => x !== s.id);
  });

  // ---------- Conectores ----------
  const publicView = (c: AreaDb["connectors"][number]): ConnectorDTO => {
    const { secretHeaders: _h, secretEnv: _e, ...rest } = c;
    return { ...rest, hasSecrets: Object.keys(c.secretHeaders).length + Object.keys(c.secretEnv).length > 0, secretHeaderNames: Object.keys(c.secretHeaders), secretEnvNames: Object.keys(c.secretEnv) };
  };
  const findConnector = (id: string) => {
    const c = db.connectors.find((x) => x.id === id);
    if (!c) throw new HttpError(404, "not_found", "Conector não encontrado.");
    return c;
  };
  const canEditConnector = (c: ConnectorDTO) => {
    if (c.ownerUserId !== db.user.id) throw new HttpError(403, "connector_owner_required", "Só quem conectou pode mudar este conector.");
  };
  const canDeleteConnector = (c: ConnectorDTO) => {
    if (c.ownerUserId !== db.user.id && !isAdmin()) throw new HttpError(403, "forbidden", "Só quem conectou ou um admin remove o conector.");
  };
  const validate = (body: Record<string, unknown>, partial: boolean) => {
    if (!partial || "name" in body) if (!String(body.name ?? "").trim()) throw new HttpError(400, "invalid", "Dê um nome ao conector.");
    const transport = body.transport;
    if (transport === "http" && !String(body.url ?? "").startsWith("http")) throw new HttpError(400, "invalid", "Informe o endereço (https://…) do servidor MCP.");
    if (transport === "stdio" && !String(body.command ?? "").trim()) throw new HttpError(400, "invalid", "Informe o comando que inicia o servidor MCP.");
  };
  on("GET", `${W}/connectors`, () => ({ items: db.connectors.map(publicView) }));
  on(
    "POST",
    `${W}/connectors`,
    ({ body }) => {
      validate(body, false);
      const c: AreaDb["connectors"][number] = {
        id: ctx.id("con"),
        name: body.name.trim(),
        transport: body.transport,
        url: body.transport === "http" ? body.url : null,
        command: body.transport === "stdio" ? body.command : null,
        args: body.args ?? [],
        ownerUserId: db.user.id,
        hasSecrets: false,
        createdAt: Date.now(),
        secretHeaders: body.headers ?? {},
        secretEnv: body.env ?? {},
      };
      db.connectors.push(c);
      return publicView(c);
    },
    201,
  );
  on("PATCH", `${W}/connectors/:id`, ({ m, body }) => {
    const c = findConnector(m[2]!);
    canEditConnector(c);
    validate({ transport: c.transport, url: c.url, command: c.command, ...body }, true);
    for (const k of ["name", "transport", "url", "command", "args"] as const) if (k in body) (c as unknown as Record<string, unknown>)[k] = body[k];
    if (body.headers) c.secretHeaders = body.headers;
    if (body.env) c.secretEnv = body.env;
    return publicView(c);
  });
  on("DELETE", `${W}/connectors/:id`, ({ m }) => {
    const c = findConnector(m[2]!);
    canDeleteConnector(c);
    db.connectors = db.connectors.filter((x) => x.id !== c.id);
    for (const a of db.agents) delete a.toolPerms[`connector:${c.id}`];
  });
}
