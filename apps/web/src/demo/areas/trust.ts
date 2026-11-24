/**
 * Terceira leva no modo demonstração: catálogo, regras, uso, canais de conversa, cofre e preparação
 * automática, com dados em memória. O que depende de um computador ligado ou de um serviço de verdade
 * (agente criador, login pelo site, transcrição) responde com uma explicação.
 */
import { CATALOG, catalogApp, type ChatLinkDTO, type RoutineDTO, type TrustRuleDTO, type UsageEntryDTO, type UsageSummaryDTO, type VaultItemDTO } from "@puxibot/shared";
import { nextRun } from "../../lib/cron";
import { HttpError, type DemoContext } from "../backend";

export function registerTrust(ctx: DemoContext): void {
  const { db, on, W, id } = ctx;
  const rules: TrustRuleDTO[] = [];
  const vault: VaultItemDTO[] = [];
  const links = new Map<ChatLinkDTO["provider"], ChatLinkDTO>();
  const chatLink = (provider: ChatLinkDTO["provider"]): ChatLinkDTO =>
    links.get(provider) ?? { provider, available: provider === "telegram", linked: false, linkCode: null, address: provider === "telegram" ? "puxibot_demo_bot" : null, workspaceId: null, agentId: null };

  on("GET", `${W}/features`, () => ({ transcription: false, telegramChat: true, whatsappChat: false, trustModel: false }));

  // ---------- Catálogo ----------
  on("GET", `${W}/connectors/catalog`, () => ({ items: CATALOG, callbackUrl: `${location.origin}/api/oauth/callback` }));
  on(
    "POST",
    `${W}/connectors/from-catalog`,
    ({ body }) => {
      const app = catalogApp(body.catalogId);
      if (!app) throw new HttpError(404, "not_found", "App não encontrado no catálogo.");
      const oauth = body.method === "oauth2";
      const c = {
        id: id("con"),
        name: body.name ?? app.displayName,
        transport: "http" as const,
        url: app.url,
        command: null,
        args: [],
        ownerUserId: db.user.id,
        hasSecrets: !oauth,
        secretHeaderNames: oauth ? [] : ["Authorization"],
        secretEnvNames: [],
        createdAt: Date.now(),
        catalogId: app.id,
        auth: oauth ? ("oauth" as const) : ("static" as const),
        oauthStatus: oauth ? ("pending" as const) : null,
        secretHeaders: {},
        secretEnv: {},
      };
      db.connectors.push(c);
      for (const agentId of (body.grantAgentIds ?? []) as string[]) {
        const a = db.agents.find((x) => x.id === agentId);
        if (a) a.toolPerms = { ...a.toolPerms, [`connector:${c.id}`]: "write" };
      }
      const { secretHeaders: _h, secretEnv: _e, ...dto } = c;
      return dto;
    },
    201,
  );
  on("POST", `${W}/connectors/:id/oauth/start`, () => {
    throw new HttpError(400, "demo", "No modo demonstração não há login de verdade no serviço.");
  });
  on("POST", `${W}/connectors/:id/grant`, () => ({ ok: true }));

  // ---------- Regras ----------
  on("GET", `${W}/agents/:id/trust-rules`, ({ m }) => ({ items: rules.filter((r) => r.agentId === m[2]) }));
  on("PUT", `${W}/agents/:id/trust-rules`, ({ m, body }) => {
    const tool = String(body.tool ?? "*") || "*";
    let rule = rules.find((r) => r.agentId === m[2] && r.connectorId === body.connectorId && r.tool === tool);
    if (rule) rule.effect = body.effect;
    else {
      rule = { id: id("rule"), agentId: m[2]!, connectorId: body.connectorId, tool, effect: body.effect, createdBy: db.user.id, createdAt: Date.now() };
      rules.push(rule);
    }
    return rule;
  });
  on("DELETE", `${W}/agents/:id/trust-rules/:rid`, ({ m }) => {
    const i = rules.findIndex((r) => r.id === m[3]);
    if (i >= 0) rules.splice(i, 1);
    return undefined;
  });

  // ---------- Uso ----------
  const entries = (): UsageEntryDTO[] =>
    [...db.jobs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({
        jobId: j.id,
        agentId: j.agentId,
        origin: j.origin,
        mode: null,
        requestedByUserId: j.requestedByUserId,
        routineId: j.routineId,
        prompt: j.prompt,
        status: j.status,
        inputTokens: j.inputTokens,
        outputTokens: j.outputTokens,
        model: j.model,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        actions: [],
      }));
  on("GET", `${W}/usage`, () => ({ items: entries().slice(0, 50), nextBefore: null }));
  on("GET", `${W}/usage/summary`, ({ query }): UsageSummaryDTO => {
    const list = entries();
    const byAgent = new Map<string, { runs: number; tokens: number }>();
    for (const e of list) {
      const cur = byAgent.get(e.agentId) ?? { runs: 0, tokens: 0 };
      byAgent.set(e.agentId, { runs: cur.runs + 1, tokens: cur.tokens + e.inputTokens + e.outputTokens });
    }
    return {
      period: query.get("period") ?? new Date().toISOString().slice(0, 7),
      runs: list.length,
      inputTokens: list.reduce((n, e) => n + e.inputTokens, 0),
      outputTokens: list.reduce((n, e) => n + e.outputTokens, 0),
      backgroundTokens: list.filter((e) => e.origin === "routine").reduce((n, e) => n + e.inputTokens + e.outputTokens, 0),
      actions: { reads: 0, writes: 0, asked: 0, denied: 0 },
      byAgent: [...byAgent.entries()].map(([agentId, v]) => ({ agentId, ...v })),
      routines: [],
    };
  });

  // ---------- Preparação automática ----------
  on("PUT", `${W}/agents/:id/proactive`, ({ m, body }) => {
    const i = db.routines.findIndex((r) => r.agentId === m[2] && r.kind === "prepare");
    if (!body.enabled) {
      if (i >= 0) db.routines.splice(i, 1);
      return { routine: null };
    }
    const cron = body.cron ?? db.routines[i]?.cron ?? "0 8-18/2 * * 1-5";
    const timezone = body.timezone ?? db.routines[i]?.timezone ?? "America/Sao_Paulo";
    const routine: RoutineDTO = {
      id: db.routines[i]?.id ?? id("rt"),
      agentId: m[2]!,
      name: "Preparação automática",
      prompt: "Olhe as fontes conectadas e prepare o que estiver em aberto.",
      cron,
      timezone,
      channelId: null,
      enabled: true,
      kind: "prepare",
      nextRunAt: nextRun(cron, Date.now(), timezone),
      lastRunAt: db.routines[i]?.lastRunAt ?? null,
    };
    if (i >= 0) db.routines[i] = routine;
    else db.routines.push(routine);
    return { routine };
  });

  // ---------- Canais de conversa ----------
  on("GET", `${W}/chat-links`, () => ({ items: [chatLink("telegram"), chatLink("whatsapp")] }));
  on(
    "POST",
    `${W}/chat-links`,
    ({ m, body }) => {
      const link: ChatLinkDTO = { ...chatLink(body.provider), linked: false, linkCode: "DEMO1234", workspaceId: m[1]!, agentId: body.agentId };
      links.set(body.provider, link);
      return link;
    },
    201,
  );
  on("DELETE", `${W}/chat-links/:provider`, ({ m }) => {
    links.delete(m[2] as ChatLinkDTO["provider"]);
    return undefined;
  });

  // ---------- Cofre ----------
  const origin = (site: string) => new URL(/^[a-z]+:\/\//i.test(site) ? site : `https://${site}`).origin;
  on("GET", `${W}/vault`, () => ({ items: vault }));
  on(
    "POST",
    `${W}/vault`,
    ({ body }) => {
      if (vault.some((v) => v.name.toLowerCase() === String(body.name).toLowerCase())) throw new HttpError(409, "vault_name_taken", "Você já tem um login com esse nome.");
      const now = Date.now();
      const item: VaultItemDTO = { id: id("vault"), name: body.name, origin: origin(body.site), username: body.username, createdAt: now, updatedAt: now, lastUsedAt: null };
      vault.push(item);
      return item;
    },
    201,
  );
  on("PATCH", `${W}/vault/:id`, ({ m, body }) => {
    const item = vault.find((v) => v.id === m[2]);
    if (!item) throw new HttpError(404, "not_found", "Login não encontrado.");
    Object.assign(item, { ...(body.name ? { name: body.name } : {}), ...(body.site ? { origin: origin(body.site) } : {}), ...(body.username ? { username: body.username } : {}), updatedAt: Date.now() });
    return item;
  });
  on("DELETE", `${W}/vault/:id`, ({ m }) => {
    const i = vault.findIndex((v) => v.id === m[2]);
    if (i >= 0) vault.splice(i, 1);
    return undefined;
  });

  // ---------- O que precisa de um computador ligado ----------
  on("POST", `${W}/setup/session`, () => {
    throw new HttpError(400, "demo", "O agente criador trabalha num computador ligado, e o modo demonstração não tem um. Rode o hub de verdade para experimentar.");
  });
  on("GET", `${W}/setup/plan`, () => ({ plan: null }));
}
