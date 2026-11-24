import { afterEach, describe, expect, it } from "vitest";
import { CATALOG, CATALOG_SOURCES, isPrivateHost, isPublicHttpsUrl, loadCatalogApp, type AgentDTO, type CatalogApp, type ConnectorDTO, type HubToRunner, type SetupPlanDTO, type SetupSessionDTO } from "@puxibot/shared";
import { setOAuthFetch } from "../src/domain/connectorOauth";
import { call, connectRunner, createAgentFor, createRunnerToken, createWorkspace, eventually, openBrowserSocket, runningJob, signup, tokenReq } from "./helpers";

type Assign = Extract<HubToRunner, { type: "job.assign" }>;

afterEach(() => setOAuthFetch());

describe("catálogo de conectores", () => {
  it("toda pasta de app passa no esquema e tem endereço HTTPS público", () => {
    expect(CATALOG.map((a) => a.id).sort()).toEqual(["composio", "linear", "meta-ads", "notion"]);
    for (const src of CATALOG_SOURCES) expect(() => loadCatalogApp(src.plugin, src.mcp, src.app)).not.toThrow();
    const meta = CATALOG.find((a) => a.id === "meta-ads")!;
    expect(meta).toMatchObject({ url: "https://mcp.facebook.com/ads", authentication: ["bearer", "oauth2"], clientIdRequired: true });
    expect(meta.hints.token).toBeTruthy();
  });

  it("recusa receita com endereço local, com credencial na URL ou com campos fora do perfil", () => {
    const [src] = CATALOG_SOURCES;
    const withUrl = (url: string) => ({ ...(src!.mcp as object), mcpServers: { "meta-ads": { type: "streamable-http", url } } });
    for (const bad of ["http://mcp.facebook.com/ads", "https://localhost/mcp", "https://10.0.0.5/mcp", "https://user:pw@mcp.x.com/mcp", "https://mcp.x.com/mcp?k=1", "https://mcp.x.com:8443/mcp"]) {
      expect(() => loadCatalogApp(src!.plugin, withUrl(bad), src!.app), bad).toThrow();
    }
    expect(() => loadCatalogApp(src!.plugin, src!.mcp, { ...(src!.app as object), installScript: "curl x | sh" })).toThrow();
    expect(() => loadCatalogApp(src!.plugin, src!.mcp, { ...(src!.app as object), prompts: ["só um"] })).toThrow();
    expect(isPublicHttpsUrl("https://mcp.linear.app/mcp")).toBe(true);
    for (const h of ["localhost", "127.0.0.1", "192.168.1.9", "172.20.0.1", "169.254.169.254", "intranet", "x.internal", "::1", "fd00::1"]) expect(isPrivateHost(h), h).toBe(true);
    expect(isPrivateHost("mcp.notion.com")).toBe(false);
  });

  it("conectar Meta Ads com token: endereço da receita, token cifrado, acesso liberado para o agente escolhido", async () => {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const base = `/api/workspaces/${ws.id}`;
    const agent = await createAgentFor(owner, ws.id, "Dani");
    const catalog = (await owner.get<{ items: CatalogApp[]; callbackUrl: string }>(`${base}/connectors/catalog`)).body;
    expect(catalog.items.map((a) => a.id)).toContain("meta-ads");
    expect(catalog.callbackUrl).toMatch(/\/api\/oauth\/callback$/);
    const created = await owner.post<ConnectorDTO>(`${base}/connectors/from-catalog`, { catalogId: "meta-ads", method: "bearer", token: "Bearer EAAB-token-secreto", grantAgentIds: [agent.id] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Meta Ads", catalogId: "meta-ads", url: "https://mcp.facebook.com/ads", auth: "static", secretHeaderNames: ["Authorization"] });
    expect(JSON.stringify(created.body)).not.toContain("EAAB-token-secreto");
    expect((await owner.get<AgentDTO>(`${base}/agents/${agent.id}`)).body.toolPerms[`connector:${created.body.id}`]).toBe("write");
    // O trabalho recebe o cabeçalho montado pelo hub (sem "Bearer Bearer").
    const job = await runningJob(owner, ws.id, agent.id, "relatório");
    expect(job.assignment.connectors).toEqual([expect.objectContaining({ id: created.body.id, url: "https://mcp.facebook.com/ads", headers: { Authorization: "Bearer EAAB-token-secreto" }, level: "write" })]);
    // Forma de conexão que o app não aceita, e endereço de receita que não muda.
    expect((await owner.post(`${base}/connectors/from-catalog`, { catalogId: "notion", method: "bearer", token: "x" })).status).toBe(400);
    expect((await owner.post(`${base}/connectors/from-catalog`, { catalogId: "meta-ads", method: "oauth2" })).status).toBe(400);
    expect((await owner.patch(`${base}/connectors/${created.body.id}`, { url: "https://outro.exemplo.com/mcp" })).status).toBe(400);
  });

  it("só libera junto com a criação para agentes que a pessoa administra", async () => {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const base = `/api/workspaces/${ws.id}`;
    const agent = await createAgentFor(owner, ws.id, "Dani");
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    const denied = await other.post(`${base}/connectors/from-catalog`, { catalogId: "meta-ads", method: "bearer", token: "tok-da-bia-123", grantAgentIds: [agent.id] });
    expect(denied.status).toBe(403);
    expect((await other.get<{ items: ConnectorDTO[] }>(`${base}/connectors`)).body.items).toEqual([]);
  });
});

/** Serviço falso com o fluxo OAuth padrão do MCP: descoberta, registro de cliente e troca de código. */
function fakeOAuthService(opts: { expiresIn?: number } = {}) {
  const log = { registered: 0, tokenCalls: [] as Record<string, string>[], urls: [] as string[] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    log.urls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.hostname === "mcp.servico.test" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: "https://mcp.servico.test/mcp", authorization_servers: ["https://login.servico.test"] });
    }
    if (url.hostname === "login.servico.test" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: "https://login.servico.test",
        authorization_endpoint: "https://login.servico.test/authorize",
        token_endpoint: "https://login.servico.test/token",
        registration_endpoint: "https://login.servico.test/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.hostname === "login.servico.test" && url.pathname === "/register") {
      log.registered += 1;
      const meta = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
      return json({ client_id: "cliente-registrado", redirect_uris: meta.redirect_uris, token_endpoint_auth_method: "none" }, 201);
    }
    if (url.hostname === "login.servico.test" && url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      log.tokenCalls.push(form);
      if (form.grant_type === "authorization_code") {
        if (form.code !== "codigo-bom" || !form.code_verifier) return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "acesso-1", token_type: "Bearer", expires_in: opts.expiresIn ?? 3600, refresh_token: "renova-1" });
      }
      if (form.grant_type === "refresh_token" && form.refresh_token === "renova-1") {
        return json({ access_token: "acesso-2", token_type: "Bearer", expires_in: 3600, refresh_token: "renova-2" });
      }
      return json({ error: "invalid_grant" }, 400);
    }
    return new Response("não encontrado", { status: 404 });
  };
  return { fetchFn, log };
}

describe("login OAuth de conector pelo hub", () => {
  async function setup(expiresIn?: number) {
    const svc = fakeOAuthService({ expiresIn });
    setOAuthFetch(svc.fetchFn);
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const base = `/api/workspaces/${ws.id}`;
    const conn = (await owner.post<ConnectorDTO>(`${base}/connectors`, { name: "Projetos", transport: "http", url: "https://mcp.servico.test/mcp", auth: "oauth" })).body;
    return { svc, owner, ws, base, conn };
  }
  const callback = (c: { cookie: string | null }, query: string) => call(`/api/oauth/callback?${query}`, { headers: c.cookie ? { Cookie: c.cookie } : {}, redirect: "manual" });

  it("começa com PKCE e registro automático; o retorno guarda o acesso e o trabalho recebe o token", async () => {
    const { svc, owner, ws, base, conn } = await setup();
    expect(conn).toMatchObject({ auth: "oauth", oauthStatus: "pending", hasSecrets: false });
    const start = await owner.post<{ url: string }>(`${base}/connectors/${conn.id}/oauth/start`);
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.origin + url.pathname).toBe("https://login.servico.test/authorize");
    expect(url.searchParams.get("client_id")).toBe("cliente-registrado");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/oauth\/callback$/);
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(svc.log.registered).toBe(1);

    const back = await callback(owner, `state=${state}&code=codigo-bom`);
    expect(back.status).toBe(302);
    const loc = new URL(back.headers.get("Location")!);
    expect(loc.pathname).toBe(`/w/${ws.id}/config/conectores`);
    expect(Object.fromEntries(loc.searchParams)).toEqual({ oauth: "ok", conector: conn.id });
    expect(svc.log.tokenCalls[0]).toMatchObject({ grant_type: "authorization_code", code: "codigo-bom" });
    const after = (await owner.get<ConnectorDTO>(`${base}/connectors/${conn.id}`)).body;
    expect(after.oauthStatus).toBe("connected");
    expect(JSON.stringify(after)).not.toMatch(/acesso-1|renova-1/);

    const agent = await createAgentFor(owner, ws.id, "Lia");
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "read" } });
    const job = await runningJob(owner, ws.id, agent.id, "liste os projetos");
    expect(job.assignment.connectors).toEqual([expect.objectContaining({ id: conn.id, headers: { Authorization: "Bearer acesso-1" }, level: "read" })]);
    // O mesmo retorno não vale duas vezes.
    const again = await callback(owner, `state=${state}&code=codigo-bom`);
    expect(new URL(again.headers.get("Location")!).searchParams.get("oauth")).toBe("erro");
  });

  it("renova o acesso que está para vencer antes de entregar o trabalho", async () => {
    const { svc, owner, ws, base, conn } = await setup(600);
    const state = new URL((await owner.post<{ url: string }>(`${base}/connectors/${conn.id}/oauth/start`)).body.url).searchParams.get("state")!;
    await callback(owner, `state=${state}&code=codigo-bom`);
    const agent = await createAgentFor(owner, ws.id, "Lia");
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "read" } });
    const job = await runningJob(owner, ws.id, agent.id, "liste");
    expect(job.assignment.connectors[0]!.headers).toEqual({ Authorization: "Bearer acesso-2" });
    expect(svc.log.tokenCalls.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "renova-1" });
  });

  it("quando a renovação é recusada, o conector pede login de novo e fica fora do trabalho", async () => {
    const { owner, ws, base, conn } = await setup(600);
    const state = new URL((await owner.post<{ url: string }>(`${base}/connectors/${conn.id}/oauth/start`)).body.url).searchParams.get("state")!;
    await callback(owner, `state=${state}&code=codigo-bom`);
    setOAuthFetch(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const agent = await createAgentFor(owner, ws.id, "Lia");
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "read" } });
    const job = await runningJob(owner, ws.id, agent.id, "liste");
    expect(job.assignment.connectors).toEqual([]);
    expect((await owner.get<ConnectorDTO>(`${base}/connectors/${conn.id}`)).body.oauthStatus).toBe("signin_required");
  });

  it("só quem começou termina; código recusado, cancelamento e estado desconhecido voltam com erro, sem guardar nada", async () => {
    const { owner, ws, base, conn } = await setup();
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    expect((await other.post(`${base}/connectors/${conn.id}/oauth/start`)).status).toBe(403);
    const state1 = new URL((await owner.post<{ url: string }>(`${base}/connectors/${conn.id}/oauth/start`)).body.url).searchParams.get("state")!;
    // Outra pessoa com o `state` na mão não conclui o login.
    const stolen = await callback(other, `state=${state1}&code=codigo-bom`);
    expect(new URL(stolen.headers.get("Location")!).searchParams.get("oauth")).toBe("erro");
    // Sem sessão: volta para a entrada.
    expect(new URL((await callback({ cookie: null }, `state=${state1}&code=codigo-bom`)).headers.get("Location")!).pathname).toBe("/");
    const state2 = new URL((await owner.post<{ url: string }>(`${base}/connectors/${conn.id}/oauth/start`)).body.url).searchParams.get("state")!;
    const bad = await callback(owner, `state=${state2}&code=codigo-ruim`);
    expect(new URL(bad.headers.get("Location")!).searchParams.get("motivo")).toMatch(/recusou o login/);
    const state3 = new URL((await owner.post<{ url: string }>(`${base}/connectors/${conn.id}/oauth/start`)).body.url).searchParams.get("state")!;
    const cancelled = await callback(owner, `state=${state3}&error=access_denied`);
    expect(new URL(cancelled.headers.get("Location")!).searchParams.get("motivo")).toMatch(/cancelou/);
    expect(new URL((await callback(owner, "state=inventado&code=x")).headers.get("Location")!).searchParams.get("oauth")).toBe("erro");
    expect((await owner.get<ConnectorDTO>(`${base}/connectors/${conn.id}`)).body.oauthStatus).toBe("pending");
    void ws;
  });

  it("recusa login em endereço local ou sem HTTPS, na criação e em cada passo do fluxo", async () => {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const base = `/api/workspaces/${ws.id}`;
    for (const url of ["http://mcp.servico.test/mcp", "https://localhost:8443/mcp", "https://192.168.0.10/mcp", "https://169.254.169.254/mcp"]) {
      expect((await owner.post(`${base}/connectors`, { name: "X", transport: "http", url, auth: "oauth" })).status, url).toBe(400);
    }
    expect((await owner.post(`${base}/connectors`, { name: "X", transport: "stdio", command: "npx", auth: "oauth" })).status).toBe(400);
    // Serviço que aponta o servidor de autorização para a rede interna: o fetch real recusa o endereço.
    const conn = (await owner.post<ConnectorDTO>(`${base}/connectors`, { name: "Ruim", transport: "http", url: "https://mcp.servico.test/mcp", auth: "oauth" })).body;
    const real = (await import("../src/domain/connectorOauth")).assertPublicHttps;
    setOAuthFetch(async (input) => {
      const u = new URL(input);
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify({ resource: "https://mcp.servico.test/mcp", authorization_servers: ["https://10.0.0.1"] }), { headers: { "Content-Type": "application/json" } });
      }
      real(u); // o que o fetch de produção faz primeiro
      return new Response("x", { status: 404 });
    });
    const start = await owner.post<{ error: { code: string } }>(`${base}/connectors/${conn.id}/oauth/start`);
    expect(start.status).toBe(400);
  });
});

describe("agente criador", () => {
  const PLAN = {
    summary: "Atendimento e mídia paga para a agência.",
    channels: [{ name: "clientes", section: "Atendimento", topic: "Pedidos dos clientes" }],
    agents: [
      { handle: "midia", name: "Dani", role: "Mídia paga", description: "Analisa campanhas.", instructions: "Você analisa campanhas da Meta e resume os resultados.", channels: ["clientes", "midia"], connectors: ["meta-ads"], skills: ["Relatório semanal"] },
      { handle: "atendimento", name: "Bia", instructions: "Você organiza pedidos de clientes.", channels: ["clientes"], connectors: [], skills: [] },
    ],
    skills: [{ name: "Relatório semanal", description: "Como montar o relatório.", body: "1. Consulte as campanhas.\n2. Monte a tabela." }],
    routines: [{ agent: "midia", name: "Relatório de segunda", prompt: "Monte o relatório semanal.", cron: "0 9 * * 1", channel: "midia" }],
    wikiPages: [{ title: "Como atendemos", body: "Respondemos em até 4 horas." }],
    memories: ["O cliente Padaria Sol paga no dia 10."],
    connectors: [{ catalogId: "meta-ads", name: "Meta Ads", reason: "Ler resultados das campanhas." }],
  };

  async function setup() {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const base = `/api/workspaces/${ws.id}`;
    const session = (await owner.post<SetupSessionDTO>(`${base}/setup/session`)).body;
    // O trabalho do agente criador: a pessoa escreve na DM com ele.
    const conn = await connectRunner(await createRunnerToken(owner, ws.id), ws.id, { capacity: 4 });
    await owner.post(`${base}/channels/${session.channelId}/messages`, { body: "Somos uma agência; quero ajuda com mídia paga." });
    const assign = await conn.sock.waitFor<Assign>((m) => m.type === "job.assign" && m.assignment.agent.id === session.agentId);
    conn.sock.send({ type: "job.accepted", jobId: assign.assignment.jobId, cli: "claude", model: "haiku" });
    await eventually(async () => (await owner.get<{ items: { id: string; status: string }[] }>(`${base}/jobs?agentId=${session.agentId}`)).body.items.find((j) => j.status === "running"));
    return { owner, ws, base, session, assignment: assign.assignment, token: assign.assignment.jobToken, runner: conn };
  }

  it("a sessão cria um agente criador só da pessoa, com permissões mínimas, e é idempotente", async () => {
    const { owner, base, session, assignment } = await setup();
    const again = (await owner.post<SetupSessionDTO>(`${base}/setup/session`)).body;
    expect(again).toMatchObject({ agentId: session.agentId, channelId: session.channelId, plan: null });
    const agent = (await owner.get<AgentDTO>(`${base}/agents/${session.agentId}`)).body;
    expect(agent).toMatchObject({ systemKind: "builder", accessMode: "owner", isAssistant: false, learnSkills: false });
    expect(agent.toolPerms).toMatchObject({ messages: "read", agents: "read", memory: "none", tasks: "none", drive: "none" });
    expect(assignment.agent.systemKind).toBe("builder");
  });

  it("só o agente criador entrega plano; plano inconsistente é recusado com o motivo", async () => {
    const { owner, ws, token, runner } = await setup();
    const other = await createAgentFor(owner, ws.id, "Marcos");
    const job = await runningJob(owner, ws.id, other.id, "oi", runner);
    expect((await tokenReq(job.token, "POST", "/api/tool/setup/plan", PLAN)).status).toBe(403);
    expect((await tokenReq(job.token, "GET", "/api/tool/setup/catalog")).status).toBe(403);
    const cat = await tokenReq<{ catalogo: { catalogId: string }[] }>(token, "GET", "/api/tool/setup/catalog");
    expect(cat.body.catalogo.map((c) => c.catalogId)).toContain("meta-ads");
    const bad = async (patch: Record<string, unknown>) => (await tokenReq<{ error: { message: string } }>(token, "POST", "/api/tool/setup/plan", { ...PLAN, ...patch })).body.error?.message;
    expect(await bad({ routines: [{ ...PLAN.routines[0], agent: "fantasma" }] })).toMatch(/@fantasma, que não está em agents/);
    expect(await bad({ routines: [{ ...PLAN.routines[0], cron: "todo dia" }] })).toMatch(/rotina "Relatório de segunda"/);
    expect(await bad({ connectors: [{ catalogId: "gmail-inventado", name: "Gmail", reason: "x" }], agents: [{ ...PLAN.agents[0], connectors: ["gmail-inventado"] }] })).toMatch(/não está no catálogo/);
    expect(await bad({ agents: [{ ...PLAN.agents[0], skills: ["Skill que não existe"] }] })).toMatch(/usa a skill/);
    expect(await bad({ agents: [PLAN.agents[0], PLAN.agents[0]] })).toMatch(/repetido/);
  });

  it("propor avisa a tela; aplicar cria tudo de uma vez, sem mexer no que já existe, e lista as conexões pendentes", async () => {
    const { owner, ws, base, token } = await setup();
    // Já existe um agente com o mesmo @ e uma página com o mesmo título: nada neles muda.
    const existing = (await owner.post<AgentDTO>(`${base}/agents`, { handle: "atendimento", name: "Antiga", instructions: "instruções originais" })).body;
    await owner.post(`${base}/wiki`, { title: "Como atendemos", body: "texto original" });
    const sock = await openBrowserSocket(owner, ws.id);
    const proposed = await tokenReq<{ ok: boolean; planId: string }>(token, "POST", "/api/tool/setup/plan", PLAN);
    expect(proposed.status).toBe(200);
    const ev = await sock.waitFor((m) => m.type === "setup.plan.upserted");
    expect(ev).toMatchObject({ plan: { id: proposed.body.planId, status: "draft" } });
    // Nada foi criado só por propor.
    expect((await owner.get<{ agents: AgentDTO[] }>(`${base}/bootstrap`)).body.agents.some((a) => a.handle === "midia")).toBe(false);
    // Propor de novo substitui o rascunho, e a pessoa pode editar.
    const second = await tokenReq<{ planId: string }>(token, "POST", "/api/tool/setup/plan", { ...PLAN, summary: "Versão dois." });
    expect(second.body.planId).toBe(proposed.body.planId);
    const edited = await owner.req<SetupPlanDTO>("PUT", `${base}/setup/plans/${proposed.body.planId}`, { ...PLAN, summary: "Editado pela pessoa." });
    expect(edited.body.plan.summary).toBe("Editado pela pessoa.");

    const applied = await owner.post<SetupPlanDTO>(`${base}/setup/plans/${proposed.body.planId}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe("applied");
    const r = applied.body.result!;
    expect(r.created).toMatchObject({ channels: ["clientes", "midia"], agents: ["@midia"], skills: ["Relatório semanal"], routines: ["Relatório de segunda"], wikiPages: [], memories: 1 });
    expect(r.skipped.map((s) => [s.kind, s.name])).toEqual([
      ["agent", "@atendimento"],
      ["wikiPage", "Como atendemos"],
    ]);
    const boot = (await owner.get<{ agents: AgentDTO[]; channels: { id: string; name: string | null; members: { type: string; id: string }[] }[] }>(`${base}/bootstrap`)).body;
    const midia = boot.agents.find((a) => a.handle === "midia")!;
    expect(midia).toMatchObject({ name: "Dani", ownerUserId: owner.userId, trustMode: "ask" });
    expect(midia.skillIds).toHaveLength(1);
    expect(boot.agents.find((a) => a.id === existing.id)).toMatchObject({ name: "Antiga", instructions: "instruções originais" });
    for (const name of ["clientes", "midia"]) expect(boot.channels.find((c) => c.name === name)!.members).toContainEqual({ type: "agent", id: midia.id });
    expect(r.pendingConnectors).toEqual([{ catalogId: "meta-ads", name: "Meta Ads", reason: "Ler resultados das campanhas.", agentIds: [midia.id], agentNames: ["Dani"], connectorId: null }]);
    // Conectar depois, liberando para o agente do plano.
    const conn = (await owner.post<ConnectorDTO>(`${base}/connectors/from-catalog`, { catalogId: "meta-ads", method: "bearer", token: "EAAB-123456", grantAgentIds: r.pendingConnectors[0]!.agentIds })).body;
    expect((await owner.get<AgentDTO>(`${base}/agents/${midia.id}`)).body.toolPerms[`connector:${conn.id}`]).toBe("write");
    // Plano aplicado não aplica de novo.
    expect((await owner.post(`${base}/setup/plans/${proposed.body.planId}/apply`)).status).toBe(409);
    sock.close();
  });

  it("o plano de uma pessoa não é visto nem aplicado por outra", async () => {
    const { owner, base, token } = await setup();
    const proposed = await tokenReq<{ planId: string }>(token, "POST", "/api/tool/setup/plan", PLAN);
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    expect((await other.get<{ plan: SetupPlanDTO | null }>(`${base}/setup/plan`)).body.plan).toBeNull();
    expect((await other.post(`${base}/setup/plans/${proposed.body.planId}/apply`)).status).toBe(404);
    expect((await owner.post(`${base}/setup/plans/${proposed.body.planId}/discard`)).status).toBe(204);
    expect((await owner.get<{ plan: SetupPlanDTO | null }>(`${base}/setup/plan`)).body.plan).toBeNull();
  });
});
