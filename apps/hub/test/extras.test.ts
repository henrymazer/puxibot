import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type {
  AgentDTO,
  ChannelDTO,
  ConnectorDTO,
  HubToRunner,
  JobDTO,
  MemberDTO,
  MemoryDTO,
  MessageDTO,
  MessagesPageDTO,
  RunnerPairStartResponse,
  SectorDTO,
  SkillDTO,
  StarterTeamResponse,
  TaskDTO,
} from "@puxibot/shared";
import { workerCtx } from "../src/domain/context";
import { parseRouterOutput, routeMessage, routeWithAI } from "../src/domain/routing";
import { insertMessage } from "../src/domain/messages";
import type { AppEnv } from "../src/env";
import type { ChannelRow } from "../src/domain/rows";
import {
  bootstrap,
  call,
  Client,
  connectRunner,
  createAgentFor,
  createRunnerToken,
  createWorkspace,
  eventually,
  signup,
  tokenReq,
  uniq,
} from "./helpers";

type Assign = Extract<HubToRunner, { type: "job.assign" }>;

async function setup() {
  const owner = await signup("Renato Lima");
  const ws = await createWorkspace(owner);
  return { owner, ws, base: `/api/workspaces/${ws.id}` };
}

async function join(owner: Client, base: string, name = "Zeca") {
  const c = await signup(name);
  const inv = await owner.post<{ code: string }>(`${base}/invites`, {});
  await c.post(`/api/invites/${inv.body.code}/accept`);
  return c;
}

describe("memórias, skills e conectores", () => {
  it("memória individual (responsável/admin escreve) e do time (qualquer membro edita)", async () => {
    const { owner, ws, base } = await setup();
    const zeca = await join(owner, base);
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const m = await owner.post<MemoryDTO>(`${base}/agents/${agent.id}/memories`, { content: "Usa pnpm" });
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ scope: "agent", agentId: agent.id, source: "user", createdBy: { type: "user", id: owner.userId } });
    expect((await zeca.get<{ items: MemoryDTO[] }>(`${base}/agents/${agent.id}/memories`)).body.items).toHaveLength(1);
    expect((await zeca.post(`${base}/agents/${agent.id}/memories`, { content: "x" })).status).toBe(403);
    expect((await owner.patch<MemoryDTO>(`${base}/agents/${agent.id}/memories/${m.body.id}`, { content: "Usa npm" })).body.content).toBe("Usa npm");
    expect((await owner.del(`${base}/agents/${agent.id}/memories/${m.body.id}`)).status).toBe(204);

    const team = await owner.post<MemoryDTO>(`${base}/memories`, { content: "Clientes VIP: ACME" });
    const edited = await zeca.patch<MemoryDTO>(`${base}/memories/${team.body.id}`, { content: "Clientes VIP: ACME e Globex" });
    expect(edited.status).toBe(200);
    expect((await zeca.get<{ items: MemoryDTO[] }>(`${base}/memories`)).body.items[0]!.content).toBe("Clientes VIP: ACME e Globex");
    expect((await zeca.del(`${base}/memories/${team.body.id}`)).status).toBe(204);
  });

  it("skills: CRUD e vínculo com agente via PATCH; vão no JobAssignment", async () => {
    const { owner, ws, base } = await setup();
    const zeca = await join(owner, base);
    const skill = await owner.post<SkillDTO>(`${base}/skills`, { name: "Revisão de PR", description: "Checklist", body: "# Revise\n- testes" });
    expect(skill.status).toBe(201);
    expect((await zeca.patch(`${base}/skills/${skill.body.id}`, { name: "x" })).status).toBe(403);
    expect((await owner.patch<SkillDTO>(`${base}/skills/${skill.body.id}`, { description: "Checklist de PR" })).body.description).toBe("Checklist de PR");
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const patched = await owner.patch<AgentDTO>(`${base}/agents/${agent.id}`, { skillIds: [skill.body.id] });
    expect(patched.body.skillIds).toEqual([skill.body.id]);
    const { sock } = await connectRunner(await createRunnerToken(owner, ws.id), ws.id);
    const dm = await owner.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } });
    await owner.post(`${base}/channels/${dm.body.id}/messages`, { body: "revise" });
    const a = await sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(a.assignment.agent.skills).toEqual([{ name: "Revisão de PR", description: "Checklist de PR", body: "# Revise\n- testes" }]);
    expect((await owner.get<{ items: SkillDTO[] }>(`${base}/skills`)).body.items).toHaveLength(1);
    expect((await owner.del(`${base}/skills/${skill.body.id}`)).status).toBe(204);
    expect((await owner.get<AgentDTO>(`${base}/agents/${agent.id}`)).body.skillIds).toEqual([]);
    sock.close();
  });

  it("conector: segredos não vazam em GET, só o dono concede e chegam decifrados no JobAssignment", async () => {
    const { owner, ws, base } = await setup();
    const zeca = await join(owner, base);
    const created = await zeca.post<ConnectorDTO>(`${base}/connectors`, {
      name: "GitHub",
      transport: "http",
      url: "https://mcp.github.example/mcp",
      headers: { Authorization: "Bearer ghp_SEGREDO" },
      env: { GH_TOKEN: "ghp_ENV" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ hasSecrets: true, secretHeaderNames: ["Authorization"], secretEnvNames: ["GH_TOKEN"], ownerUserId: zeca.userId });
    const list = await owner.get(`${base}/connectors`);
    expect(JSON.stringify(list.body)).not.toContain("ghp_");
    expect(JSON.stringify((await zeca.get(`${base}/connectors/${created.body.id}`)).body)).not.toContain("ghp_");
    const raw = await env.DB.prepare("SELECT secrets_enc FROM connectors WHERE id = ?").bind(created.body.id).first<{ secrets_enc: string }>();
    expect(raw!.secrets_enc).toMatch(/^v1\./);
    expect(raw!.secrets_enc).not.toContain("ghp_");
    // Owner do workspace (admin) não é dono do conector: não concede.
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const denied = await owner.patch<{ error: { code: string } }>(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${created.body.id}`]: "read" } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("connector_owner_required");
    expect((await owner.patch(`${base}/connectors/${created.body.id}`, { name: "x" })).status).toBe(403);
    // Zeca não gerencia o agente: dá a ele o agente (admin) e o dono do conector concede.
    await owner.patch(`${base}/agents/${agent.id}`, { ownerUserId: zeca.userId });
    expect((await zeca.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${created.body.id}`]: "write" } })).status).toBe(200);
    const { sock } = await connectRunner(await createRunnerToken(zeca, ws.id), ws.id);
    const dm = await zeca.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } });
    await zeca.post(`${base}/channels/${dm.body.id}/messages`, { body: "veja os PRs" });
    const a = await sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(a.assignment.connectors).toEqual([
      {
        id: created.body.id,
        name: "GitHub",
        transport: "http",
        url: "https://mcp.github.example/mcp",
        command: null,
        args: [],
        headers: { Authorization: "Bearer ghp_SEGREDO" },
        env: { GH_TOKEN: "ghp_ENV" },
        level: "write",
      },
    ]);
    // PATCH só de headers mantém env.
    await zeca.patch(`${base}/connectors/${created.body.id}`, { headers: { Authorization: "Bearer novo" } });
    expect((await zeca.get<ConnectorDTO>(`${base}/connectors/${created.body.id}`)).body.secretEnvNames).toEqual(["GH_TOKEN"]);
    expect((await zeca.del(`${base}/connectors/${created.body.id}`)).status).toBe(204);
    expect((await zeca.get<AgentDTO>(`${base}/agents/${agent.id}`)).body.toolPerms[`connector:${created.body.id}`]).toBeUndefined();
    sock.close();
  });
});

describe("roteador com Workers AI (binding falso)", () => {
  it("escolhe no máximo um agente válido; falha ou resposta estranha = nenhum", async () => {
    const candidates = [
      { id: "a1", handle: "marcos", name: "Marcos", role: "Engenharia", description: "Código" },
      { id: "a2", handle: "mari", name: "Mari", role: "Marketing", description: "Campanhas" },
    ];
    const seen: { model: string; inputs: { messages: { content: string }[]; response_format: unknown } }[] = [];
    const fakeAI = (out: unknown) =>
      ({
        run: async (model: string, inputs: never) => {
          seen.push({ model, inputs });
          if (out instanceof Error) throw out;
          return out;
        },
      }) as unknown as Ai;
    const input = { message: "o deploy quebrou, alguém olha o código?", channelName: "dev", candidates };
    expect(await routeWithAI({ AI: fakeAI({ response: { agent: "marcos" } }) }, input)).toBe("a1");
    expect(seen[0]!.model).toBe("@cf/meta/llama-3-8b-instruct");
    expect(seen[0]!.inputs.response_format).toMatchObject({ type: "json_schema" });
    expect(seen[0]!.inputs.messages[0]!.content).toContain("mari: Mari (Marketing)");
    expect(await routeWithAI({ AI: fakeAI({ response: '{"agent": "@Mari"}' }) }, input)).toBe("a2");
    expect(await routeWithAI({ AI: fakeAI({ response: { agent: null } }) }, input)).toBeNull();
    expect(await routeWithAI({ AI: fakeAI({ response: { agent: "outro" } }) }, input)).toBeNull();
    expect(await routeWithAI({ AI: fakeAI({ response: "não sei" }) }, input)).toBeNull();
    expect(await routeWithAI({ AI: fakeAI(new Error("JSON Mode couldn't be met")) }, input)).toBeNull();
    expect(await routeWithAI({}, input)).toBeNull();
    expect(parseRouterOutput({ response: { agent: 42 } })).toBeNull();
  });

  it("routeMessage com routerEnabled usa o binding e cria job só para o escolhido", async () => {
    const { owner, ws, base } = await setup();
    const marcos = await createAgentFor(owner, ws.id, "Marcos");
    const mari = await createAgentFor(owner, ws.id, "Mari", { role: "Marketing" });
    const ch = await owner.post<ChannelDTO>(`${base}/channels`, {
      name: uniq("geral"),
      members: [
        { type: "agent", id: marcos.id },
        { type: "agent", id: mari.id },
      ],
    });
    const fakeEnv = { ...env, AI: { run: async () => ({ response: { agent: mari.handle } }) } } as unknown as AppEnv;
    const ctx = workerCtx(fakeEnv, ws.id);
    const row = (await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(ch.body.id).first<ChannelRow>())!;
    const message = await insertMessage(ctx, { channel: row, author: { type: "user", id: owner.userId }, body: "precisamos de uma campanha de Natal" });
    const jobs = await routeMessage(ctx, { channel: row, message, userId: owner.userId, mentionedAgents: [], routerEnabled: true });
    expect(jobs.map((j) => j.agent_id)).toEqual([mari.id]);
    const off = await routeMessage(ctx, { channel: row, message, userId: owner.userId, mentionedAgents: [], routerEnabled: false });
    expect(off).toEqual([]);
    // Pela rota HTTP (sem binding AI no ambiente de teste) não roteia.
    await owner.patch(base, { routerEnabled: true });
    await owner.post(`${base}/channels/${ch.body.id}/messages`, { body: "campanha?" });
    expect((await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${marcos.id}`)).body.items).toHaveLength(0);
  });
});

describe("time inicial", () => {
  it("cria de 3 a 5 agentes do ramo, canais e membros; é idempotente", async () => {
    const { owner, ws, base } = await setup();
    const first = await owner.post<StarterTeamResponse>(`${base}/starter-team`, { business: "Agência de marketing digital" });
    expect(first.status).toBe(201);
    expect(first.body.template).toBe("agencia");
    expect(first.body.agents.length).toBeGreaterThanOrEqual(3);
    expect(first.body.agents.length).toBeLessThanOrEqual(5);
    expect(first.body.createdAgents).toBe(first.body.agents.length);
    expect(first.body.agents.every((a) => a.instructions.length > 200)).toBe(true);
    const clientes = first.body.channels.find((c) => c.name === "clientes")!;
    expect(clientes.members).toEqual(expect.arrayContaining([{ type: "agent", id: first.body.agents.find((a) => a.handle === "atendimento")!.id }]));
    const again = await owner.post<StarterTeamResponse>(`${base}/starter-team`, { business: "Agência de marketing digital" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ createdAgents: 0, createdChannels: 0 });
    const agents = (await bootstrap(owner, ws.id)).agents.filter((a) => !a.isAssistant);
    expect(agents.length).toBe(first.body.agents.length);
    for (const [business, key] of [
      ["loja online de roupas", "loja"],
      ["SaaS de software", "software"],
      ["consultoria e serviços", "servicos"],
      ["padaria", "generico"],
    ] as const) {
      const o = await signup("X");
      const w = await createWorkspace(o);
      const r = await o.post<StarterTeamResponse>(`/api/workspaces/${w.id}/starter-team`, { business });
      expect(r.body.template).toBe(key);
      expect(r.body.agents.length).toBeGreaterThanOrEqual(3);
    }
    const zeca = await join(owner, base);
    expect((await zeca.post(`${base}/starter-team`, { business: "software" })).status).toBe(403);
  });
});

describe("servidor MCP do hub", () => {
  async function rpc(token: string, wsId: string, body: unknown) {
    return tokenReq<any>(token, "POST", `/api/workspaces/${wsId}/mcp`, body); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it("initialize, tools/list e tools/call com token pessoal", async () => {
    const { owner, ws, base } = await setup();
    const token = (await owner.post<{ token: string }>(`${base}/tokens`, { name: "claude", kind: "personal" })).body.token;
    const init = await rpc(token, ws.id, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "puxibot-hub" } });
    expect((await rpc(token, ws.id, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await rpc(token, ws.id, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ["buscar", "criar_agente", "criar_rotina", "criar_tarefa", "listar_agentes", "listar_tarefas", "pedir_ao_agente"].sort(),
    );
    const handle = uniq("pm").slice(0, 20);
    const made = await rpc(token, ws.id, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "criar_agente", arguments: { handle, name: "Lia" } } });
    expect(made.body.result.isError).toBeUndefined();
    expect(JSON.parse(made.body.result.content[0].text)).toMatchObject({ handle, ownerUserId: owner.userId });
    const task = await rpc(token, ws.id, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "criar_tarefa", arguments: { title: "Via MCP", assigneeAgent: handle } },
    });
    expect(JSON.parse(task.body.result.content[0].text)).toMatchObject({ title: "Via MCP", number: 1 });
    const routine = await rpc(token, ws.id, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "criar_rotina", arguments: { agent: handle, name: "Diária", prompt: "Faça", cron: "0 8 * * *" } },
    });
    expect(JSON.parse(routine.body.result.content[0].text).nextRunAt).toBeGreaterThan(Date.now());
    const tasks = await rpc(token, ws.id, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "listar_tarefas", arguments: {} } });
    expect(JSON.parse(tasks.body.result.content[0].text).items).toHaveLength(1);
    const agents = await rpc(token, ws.id, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "listar_agentes", arguments: {} } });
    expect(JSON.parse(agents.body.result.content[0].text).items.map((a: { handle: string }) => a.handle)).toContain(handle);
    const bad = await rpc(token, ws.id, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "criar_rotina", arguments: { agent: handle, name: "x", prompt: "y", cron: "nope" } } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/cron inválida/);
    expect((await rpc(token, ws.id, { jsonrpc: "2.0", id: 9, method: "nada" })).body.error.code).toBe(-32601);
    const search = await rpc(token, ws.id, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "buscar", arguments: { q: "Via" } } });
    expect(JSON.parse(search.body.result.content[0].text).tasks).toHaveLength(1);
    // Token de runner não vale.
    const runnerToken = await createRunnerToken(owner, ws.id);
    expect((await rpc(runnerToken, ws.id, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
  });

  it("pedir_ao_agente cria a mensagem na DM, o job, e devolve a resposta do runner", async () => {
    const { owner, ws, base } = await setup();
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const token = (await owner.post<{ token: string }>(`${base}/tokens`, { name: "claude", kind: "personal" })).body.token;
    const { sock } = await connectRunner(await createRunnerToken(owner, ws.id), ws.id);
    const asking = rpc(token, ws.id, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pedir_ao_agente", arguments: { handle: agent.handle, prompt: "status?" } } });
    const a = await sock.waitFor<Assign>((m) => m.type === "job.assign");
    sock.send({ type: "job.accepted", jobId: a.assignment.jobId, cli: "claude", model: "haiku" });
    sock.send({ type: "job.done", jobId: a.assignment.jobId, text: "Tudo certo.", inputTokens: 1, outputTokens: 1, model: "haiku" });
    const res = await asking;
    expect(JSON.parse(res.body.result.content[0].text)).toMatchObject({ status: "done", text: "Tudo certo." });
    sock.close();
  });
});

describe("ajustes pedidos pela interface e pelo runner", () => {
  it("JobDTO.waitingForRunner liga sem runner e desliga quando um runner conecta", async () => {
    const { owner, ws, base } = await setup();
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const dm = await owner.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } });
    await owner.post(`${base}/channels/${dm.body.id}/messages`, { body: "oi" });
    const job = await eventually(async () => (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?status=queued,assigned`)).body.items.find((j) => j.waitingForRunner));
    expect(job.agentId).toBe(agent.id);
    const { sock } = await connectRunner(await createRunnerToken(owner, ws.id), ws.id);
    await sock.waitFor((m) => m.type === "job.assign");
    const after = (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agent.id}`)).body.items[0]!;
    expect(after).toMatchObject({ status: "assigned", waitingForRunner: false });
    sock.close();
  });

  it("MemberDTO.sectorId e PATCH do membro (só admin)", async () => {
    const { owner, base } = await setup();
    const zeca = await join(owner, base);
    const sector = await owner.post<SectorDTO>(`${base}/sectors`, { name: "Tech" });
    expect((await zeca.patch(`${base}/members/${zeca.userId}`, { sectorId: sector.body.id })).status).toBe(403);
    const r = await owner.patch<{ member: MemberDTO }>(`${base}/members/${zeca.userId}`, { sectorId: sector.body.id });
    expect(r.body.member.sectorId).toBe(sector.body.id);
    expect((await owner.patch(`${base}/members/${zeca.userId}`, { sectorId: "nao-existe" })).status).toBe(404);
    expect((await owner.get<{ items: MemberDTO[] }>(`${base}/members`)).body.items.find((m) => m.userId === zeca.userId)!.sectorId).toBe(sector.body.id);
  });

  it("paginação estável com created_at repetido, GET /messages/:id e raiz da thread", async () => {
    const { owner, ws, base } = await setup();
    const ch = (await bootstrap(owner, ws.id)).channels.find((c) => c.name === "general")!;
    const ts = 1_800_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `m${i}-${crypto.randomUUID()}`;
      ids.push(id);
      await env.DB.prepare(
        "INSERT INTO messages (id, workspace_id, channel_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)",
      )
        .bind(id, ws.id, ch.id, owner.userId, `msg ${i}`, ts)
        .run();
    }
    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 5; page++) {
      const q: string = before ? `&before=${encodeURIComponent(before)}` : "";
      const res = await owner.get<MessagesPageDTO>(`${base}/channels/${ch.id}/messages?limit=2${q}`);
      seen.unshift(...res.body.items.map((m) => m.id));
      before = res.body.nextBefore;
      if (!before) break;
    }
    expect(seen).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
    // `before` numérico antigo continua valendo.
    expect((await owner.get<MessagesPageDTO>(`${base}/channels/${ch.id}/messages?before=${ts + 1}`)).body.items).toHaveLength(5);
    expect((await owner.get(`${base}/channels/${ch.id}/messages?before=abc`)).status).toBe(400);

    const one = await owner.get<MessageDTO>(`${base}/messages/${ids[2]}`);
    expect(one.body.body).toBe("msg 2");
    const reply = await owner.post<MessageDTO>(`${base}/channels/${ch.id}/messages`, { body: "resposta", threadRootId: ids[0] });
    const thread = await owner.get<MessagesPageDTO>(`${base}/channels/${ch.id}/messages?threadRootId=${ids[0]}`);
    expect(thread.body.root?.id).toBe(ids[0]);
    expect(thread.body.items.map((m) => m.id)).toEqual([ids[0], reply.body.id]);
  });

  it("status em lista nos jobs e aprovações; DELETE de membro e reação por query string", async () => {
    const { owner, ws, base } = await setup();
    expect((await owner.get(`${base}/jobs?status=queued,running`)).status).toBe(200);
    expect((await owner.get(`${base}/jobs?status=queued,xyz`)).status).toBe(400);
    expect((await owner.get(`${base}/approvals?status=pending,approved`)).status).toBe(200);
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const ch = await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("c"), members: [{ type: "agent", id: agent.id }] });
    const del = await owner.del<ChannelDTO>(`${base}/channels/${ch.body.id}/members?type=agent&id=${agent.id}`);
    expect(del.status).toBe(200);
    expect(del.body.members.some((m) => m.type === "agent")).toBe(false);
    const msg = await owner.post<MessageDTO>(`${base}/channels/${ch.body.id}/messages`, { body: "oi" });
    await owner.post(`${base}/messages/${msg.body.id}/reactions`, { emoji: "👍" });
    const un = await owner.del<MessageDTO>(`${base}/messages/${msg.body.id}/reactions?emoji=${encodeURIComponent("👍")}`);
    expect(un.status).toBe(200);
    expect(un.body.reactions).toEqual([]);
  });

  it("membros de canal: só criador/admin adiciona outros; qualquer membro entra em canal aberto", async () => {
    const { owner, base } = await setup();
    const zeca = await join(owner, base);
    const bia = await join(owner, base, "Bia");
    const ch = await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("aberto") });
    expect((await zeca.post(`${base}/channels/${ch.body.id}/members`, { member: { type: "user", id: zeca.userId } })).status).toBe(200);
    expect((await zeca.post(`${base}/channels/${ch.body.id}/members`, { member: { type: "user", id: bia.userId } })).status).toBe(403);
    expect((await owner.post(`${base}/channels/${ch.body.id}/members`, { member: { type: "user", id: bia.userId } })).status).toBe(200);
  });

  it("runner remove o próprio registro com o token de runner; pair/start traz approveUrl; links em português", async () => {
    const { owner, ws, base } = await setup();
    const token = await createRunnerToken(owner, ws.id);
    const { sock, runnerId } = await connectRunner(token, ws.id);
    const other = await connectRunner(await createRunnerToken(owner, ws.id), ws.id);
    expect((await tokenReq(token, "DELETE", `${base}/runners/${other.runnerId}`)).status).toBe(403);
    expect((await tokenReq(token, "GET", `${base}/runners`)).status).toBe(403);
    expect((await tokenReq(token, "DELETE", `${base}/runners/${runnerId}`)).status).toBe(204);
    expect((await owner.get<{ items: { id: string }[] }>(`${base}/runners`)).body.items.map((r) => r.id)).toEqual([other.runnerId]);
    sock.close();
    other.sock.close();

    const start = await call("/api/runner/pair/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "note" }) });
    const body = (await start.json()) as RunnerPairStartResponse;
    expect(body.approveUrl).toBe(`http://localhost/parear?code=${body.pairCode}`);
    const inv = await owner.post<{ url: string; code: string }>(`${base}/invites`, {});
    expect(inv.body.url).toBe(`http://localhost/convite/${inv.body.code}`);

    // Link de aprovação e de agente.
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    await owner.patch(`${base}/agents/${agent.id}`, { budgetRunsMonth: 1 });
    const dm = await owner.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } });
    await owner.post(`${base}/channels/${dm.body.id}/messages`, { body: "oi" });
    const notes = (await owner.get<{ items: { kind: string; link: string }[] }>(`${base}/notifications`)).body.items;
    expect(notes.find((n) => n.kind === "budget")?.link).toBe(`/w/${ws.id}/equipe?agente=${agent.id}`);
    expect(notes.find((n) => n.kind === "no_runner")?.link).toBe(`/w/${ws.id}/c/${dm.body.id}`);
  });

  it("busca respeita canais visíveis e feedback publica no canal feedbacks", async () => {
    const { owner, ws, base } = await setup();
    const zeca = await join(owner, base);
    const priv = await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("priv"), isPrivate: true });
    await owner.post(`${base}/channels/${priv.body.id}/messages`, { body: "palavra-rara aqui" });
    await owner.post<TaskDTO>(`${base}/tasks`, { title: "palavra-rara na tarefa" });
    const mine = await owner.get<{ messages: unknown[]; tasks: unknown[] }>(`${base}/search?q=palavra-rara`);
    expect(mine.body.messages).toHaveLength(1);
    const his = await zeca.get<{ messages: unknown[]; tasks: unknown[]; wikiPages: unknown[]; files: unknown[] }>(`${base}/search?q=palavra-rara`);
    expect(his.body.messages).toHaveLength(0);
    expect(his.body.tasks).toHaveLength(1);

    const noChannel = await zeca.post<{ channelId: string | null }>(`${base}/feedback`, { body: "o app é ótimo" });
    expect(noChannel.status).toBe(201);
    expect(noChannel.body.channelId).toBeNull();
    const fb = await owner.post<ChannelDTO>(`${base}/channels`, { name: "feedbacks" });
    const posted = await zeca.post<{ channelId: string; messageId: string }>(`${base}/feedback`, { body: "falta modo escuro" });
    expect(posted.body.channelId).toBe(fb.body.id);
    const msgs = await owner.get<MessagesPageDTO>(`${base}/channels/${fb.body.id}/messages`);
    expect(msgs.body.items.map((m) => m.body)).toEqual(["**Feedback:** falta modo escuro"]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE workspace_id = ?").bind(ws.id).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});
