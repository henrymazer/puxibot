import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentDTO, ApprovalDTO, ChannelDTO, ClientEvent, HubToRunner, JobDTO, MessageDTO } from "@puxibot/shared";
import { JOB_MAX_ATTEMPTS } from "@puxibot/shared";
import { verifyJobToken } from "../src/lib/jobToken";
import { workerCtx } from "../src/domain/context";
import { createJob } from "../src/domain/jobs";
import type { AgentRow, JobRow } from "../src/domain/rows";
import {
  bootstrap,
  Client,
  connectRunner,
  createRunnerToken,
  createWorkspace,
  eventually,
  openBrowserSocket,
  signup,
  uniq,
} from "./helpers";

type Assign = Extract<HubToRunner, { type: "job.assign" }>;

async function setup() {
  const owner = await signup("Renato Lima");
  const ws = await createWorkspace(owner);
  const agent = await owner.post<AgentDTO>(`/api/workspaces/${ws.id}/agents`, {
    handle: uniq("marcos").toLowerCase().slice(0, 30),
    name: "Marcos",
    role: "Engenharia",
    instructions: "Você é o Marcos.",
  });
  expect(agent.status).toBe(201);
  return { owner, ws, agent: agent.body };
}

async function openDm(c: Client, wsId: string, agentId: string) {
  const dm = await c.post<ChannelDTO>(`/api/workspaces/${wsId}/dms`, { with: { type: "agent", id: agentId } });
  expect([200, 201]).toContain(dm.status);
  return dm.body;
}

async function jobs(c: Client, wsId: string, query = "") {
  return (await c.get<{ items: JobDTO[] }>(`/api/workspaces/${wsId}/jobs${query}`)).body.items;
}

async function jobRow(id: string) {
  return (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>())!;
}

async function messages(c: Client, wsId: string, channelId: string) {
  return (await c.get<{ items: MessageDTO[] }>(`/api/workspaces/${wsId}/channels/${channelId}/messages`)).body.items;
}

describe("jobs e runners", () => {
  it("DM com agente cria job queued, avisa que não há runner e o agente fica queued_no_runner", async () => {
    const { owner, ws, agent } = await setup();
    const dm = await openDm(owner, ws.id, agent.id);
    const sent = await owner.post<MessageDTO>(`/api/workspaces/${ws.id}/channels/${dm.id}/messages`, { body: "Oi Marcos" });
    expect(sent.status).toBe(201);
    const list = await jobs(owner, ws.id, `?agentId=${agent.id}`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "queued", origin: "user", channelId: dm.id, triggerMessageId: sent.body.id, prompt: "Oi Marcos" });
    const a = await owner.get<AgentDTO>(`/api/workspaces/${ws.id}/agents/${agent.id}`);
    expect(a.body.activity).toBe("queued_no_runner");
    const notes = await owner.get<{ items: { kind: string }[] }>(`/api/workspaces/${ws.id}/notifications`);
    expect(notes.body.items.filter((n) => n.kind === "no_runner")).toHaveLength(1);
  });

  it("runner falso recebe job.assign, faz stream e done; a resposta aparece no canal e no WebSocket", async () => {
    const { owner, ws, agent } = await setup();
    const browser = await openBrowserSocket(owner, ws.id);
    const token = await createRunnerToken(owner, ws.id);
    const { sock: runner, runnerId } = await connectRunner(token, ws.id);
    await browser.waitFor((m) => m.type === "presence" && m.userId === owner.userId && m.runnerOnline);

    const ch = await owner.post<ChannelDTO>(`/api/workspaces/${ws.id}/channels`, {
      name: uniq("dev"),
      members: [{ type: "agent", id: agent.id }],
    });
    await owner.post(`/api/workspaces/${ws.id}/channels/${ch.body.id}/messages`, { body: "contexto anterior" });
    const sent = await owner.post<MessageDTO>(`/api/workspaces/${ws.id}/channels/${ch.body.id}/messages`, {
      body: `@${agent.handle} qual o status do deploy?`,
    });
    expect(sent.body.mentions).toEqual([{ type: "agent", id: agent.id }]);

    const assign = await runner.waitFor<Assign>((m) => m.type === "job.assign");
    const a = assign.assignment;
    expect(a.agent).toMatchObject({ id: agent.id, name: "Marcos", instructions: "Você é o Marcos." });
    expect(a.channel).toMatchObject({ id: ch.body.id, kind: "channel" });
    expect(a.prompt).toBe(`@${agent.handle} qual o status do deploy?`);
    expect(a.requestedBy).toEqual({ userId: owner.userId, name: "Renato Lima" });
    expect(a.context.map((m) => m.body)).toEqual(["contexto anterior"]);
    expect(a.hubUrl).toBe("http://localhost");
    expect(a.teammates.some((t) => t.handle.startsWith("assistente-"))).toBe(true);
    expect(a.agent.toolPerms.tasks).toBe("write");
    const claims = await verifyJobToken(env.JOB_TOKEN_SECRET, a.jobToken);
    expect(claims).toMatchObject({ jobId: a.jobId, agentId: agent.id, workspaceId: ws.id });
    expect((await jobRow(a.jobId)).status).toBe("assigned");

    runner.send({ type: "job.accepted", jobId: a.jobId, cli: "claude", model: "opus" });
    await browser.waitFor((m) => m.type === "job.updated" && m.job.id === a.jobId && m.job.status === "running");
    runner.send({ type: "job.heartbeat", jobId: a.jobId });
    runner.send({ type: "job.event", jobId: a.jobId, kind: "tool", summary: "Leu #dev" });
    runner.send({ type: "job.stream", jobId: a.jobId, text: "O deploy" });
    const stream = await browser.waitFor<Extract<ClientEvent, { type: "job.stream" }>>((m) => m.type === "job.stream");
    expect(stream).toMatchObject({ jobId: a.jobId, channelId: ch.body.id, agentId: agent.id, text: "O deploy" });
    runner.send({ type: "job.done", jobId: a.jobId, text: "O deploy está verde.", inputTokens: 100, outputTokens: 20, model: "opus" });

    const created = await browser.waitFor<Extract<ClientEvent, { type: "message.created" }>>(
      (m) => m.type === "message.created" && m.message.author.type === "agent",
    );
    expect(created.message).toMatchObject({
      channelId: ch.body.id,
      body: "O deploy está verde.",
      author: { type: "agent", id: agent.id },
      jobId: a.jobId,
      meta: { cli: "claude", model: "opus", runnerUserId: owner.userId, runnerName: "notebook-teste" },
    });
    const msgs = await messages(owner, ws.id, ch.body.id);
    expect(msgs.at(-1)!.body).toBe("O deploy está verde.");
    const job = await jobRow(a.jobId);
    expect(job).toMatchObject({ status: "done", runner_id: runnerId, input_tokens: 100, output_tokens: 20, cli: "claude" });

    const usage = await owner.get<{ runs: number; inputTokens: number; byRunnerUser: unknown[] }>(
      `/api/workspaces/${ws.id}/agents/${agent.id}/usage`,
    );
    expect(usage.body).toMatchObject({ runs: 1, inputTokens: 100, byRunnerUser: [{ userId: owner.userId, runs: 1, tokens: 120 }] });
    const activity = await owner.get<{ items: (JobDTO & { events: { summary: string }[] })[] }>(
      `/api/workspaces/${ws.id}/agents/${agent.id}/activity`,
    );
    expect(activity.body.items[0]!.events.map((e) => e.summary)).toEqual(["Leu #dev"]);

    // Resposta em thread da mensagem do agente vai para o mesmo agente (regra 4)
    await owner.post(`/api/workspaces/${ws.id}/channels/${ch.body.id}/messages`, {
      body: "e o staging?",
      threadRootId: created.message.id,
    });
    const second = await runner.waitFor<Assign>((m) => m.type === "job.assign" && m.assignment.jobId !== a.jobId);
    expect(second.assignment.threadRootId).toBe(created.message.id);
    expect(second.assignment.context.map((m) => m.body)).toEqual(["O deploy está verde."]);
    runner.send({ type: "job.failed", jobId: second.assignment.jobId, errorCode: "limit", error: "limite da assinatura" });
    const sys = await browser.waitFor<Extract<ClientEvent, { type: "message.created" }>>(
      (m) => m.type === "message.created" && m.message.author.type === "system",
    );
    expect(sys.message.body).toBe("Marcos parou com um erro: limite da assinatura");
    expect(sys.message.threadRootId).toBe(created.message.id);
    const failed = await jobRow(second.assignment.jobId);
    expect(failed).toMatchObject({ status: "failed", error_code: "limit" });
    const notes = await owner.get<{ items: { kind: string }[] }>(`/api/workspaces/${ws.id}/notifications`);
    expect(notes.body.items.some((n) => n.kind === "job_failed")).toBe(true);

    // Tentar de novo reentrega ao runner
    const retry = await owner.post<JobDTO>(`/api/workspaces/${ws.id}/jobs/${failed.id}/retry`);
    expect(retry.status).toBe(200);
    await runner.waitFor<Assign>(
      (m) => m.type === "job.assign" && m.assignment.jobId === failed.id && runner.received.filter((x) => x.type === "job.assign").length >= 3,
    );
    // Cancelar avisa o runner
    const cancel = await owner.post<JobDTO>(`/api/workspaces/${ws.id}/jobs/${failed.id}/cancel`);
    expect(cancel.body.status).toBe("cancelled");
    await runner.waitFor((m) => m.type === "job.cancel" && m.jobId === failed.id);

    runner.close();
    browser.close();
  });

  it("job queued antes de o runner conectar é entregue quando ele conecta", async () => {
    const { owner, ws, agent } = await setup();
    const dm = await openDm(owner, ws.id, agent.id);
    await owner.post(`/api/workspaces/${ws.id}/channels/${dm.id}/messages`, { body: "faça X" });
    const token = await createRunnerToken(owner, ws.id);
    const { sock } = await connectRunner(token, ws.id);
    const assign = await sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(assign.assignment.prompt).toBe("faça X");
    expect(assign.assignment.channel?.kind).toBe("dm");
    sock.close();
  });

  it("preferredCli: runner sem a CLI não recebe o job", async () => {
    const { owner, ws, agent } = await setup();
    await owner.patch(`/api/workspaces/${ws.id}/agents/${agent.id}`, { preferredCli: "codex" });
    const token = await createRunnerToken(owner, ws.id);
    const { sock } = await connectRunner(token, ws.id, { clis: ["claude"] });
    const dm = await openDm(owner, ws.id, agent.id);
    await owner.post(`/api/workspaces/${ws.id}/channels/${dm.id}/messages`, { body: "use codex" });
    const [job] = await jobs(owner, ws.id, `?agentId=${agent.id}`);
    expect(job!.status).toBe("queued");
    const { sock: codex } = await connectRunner(token, ws.id, { clis: ["codex"] });
    const assign = await codex.waitFor<Assign>((m) => m.type === "job.assign");
    expect(assign.assignment.jobId).toBe(job!.id);
    expect(sock.received.some((m) => m.type === "job.assign")).toBe(false);
    sock.close();
    codex.close();
  });

  it("lease vencida devolve o job à fila; após JOB_MAX_ATTEMPTS falha com runner_lost", async () => {
    const { owner, ws, agent } = await setup();
    const token = await createRunnerToken(owner, ws.id);
    const { sock } = await connectRunner(token, ws.id);
    const dm = await openDm(owner, ws.id, agent.id);
    await owner.post(`/api/workspaces/${ws.id}/channels/${dm.id}/messages`, { body: "trabalho longo" });
    const first = await sock.waitFor<Assign>((m) => m.type === "job.assign");
    const jobId = first.assignment.jobId;
    sock.send({ type: "job.accepted", jobId, cli: "claude", model: null });
    await eventually(async () => (await jobRow(jobId)).status === "running");

    const stub = env.WORKSPACE_HUB.getByName(ws.id);
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt++) {
      // Simula falta de heartbeat: lease no passado e dispara o alarme.
      await env.DB.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, jobId).run();
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const row = await jobRow(jobId);
      expect(row.attempts).toBe(attempt);
      await sock.waitFor((m) => m.type === "job.cancel" && m.jobId === jobId && sock.received.filter((x) => x.type === "job.cancel").length >= attempt);
      if (attempt < JOB_MAX_ATTEMPTS) {
        // Voltou para a fila e foi reentregue ao runner que ainda está online.
        expect(["queued", "assigned"]).toContain(row.status);
        await sock.waitFor((m) => m.type === "job.assign" && sock.received.filter((x) => x.type === "job.assign").length >= attempt + 1);
        expect((await jobRow(jobId)).status).toBe("assigned");
      } else {
        expect(row).toMatchObject({ status: "failed", error_code: "runner_lost" });
      }
    }
    const msgs = await messages(owner, ws.id, dm.id);
    expect(msgs.at(-1)).toMatchObject({ author: { type: "system", id: null } });
    expect(msgs.at(-1)!.body).toMatch(/^Marcos parou com um erro: O runner parou de responder/);
    sock.close();
  });

  it("runner desconectado devolve o job à fila e outro runner assume", async () => {
    const { owner, ws, agent } = await setup();
    const token = await createRunnerToken(owner, ws.id);
    const r1 = await connectRunner(token, ws.id);
    const dm = await openDm(owner, ws.id, agent.id);
    await owner.post(`/api/workspaces/${ws.id}/channels/${dm.id}/messages`, { body: "oi" });
    const a1 = await r1.sock.waitFor<Assign>((m) => m.type === "job.assign");
    r1.sock.close();
    await eventually(async () => (await jobRow(a1.assignment.jobId)).status === "queued");
    expect((await jobRow(a1.assignment.jobId)).attempts).toBe(1);
    const r2 = await connectRunner(token, ws.id);
    const a2 = await r2.sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(a2.assignment.jobId).toBe(a1.assignment.jobId);
    r2.sock.close();
  });
});

describe("governança", () => {
  it("'quem pode falar' bloqueia com mensagem de sistema e sem job", async () => {
    const { owner, ws, agent } = await setup();
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    const zeca = await signup("Zeca", inv.body.code);
    await owner.patch(`/api/workspaces/${ws.id}/agents/${agent.id}`, { accessMode: "restricted", allowedUserIds: [] });

    // DM com agente proibido: 403
    const dm = await zeca.post<{ error: { code: string } }>(`/api/workspaces/${ws.id}/dms`, { with: { type: "agent", id: agent.id } });
    expect(dm.status).toBe(403);

    // Menção no general: mensagem de sistema, nenhum job
    const b = await bootstrap(zeca, ws.id);
    const gen = b.channels.find((c) => c.name === "general")!;
    await zeca.post(`/api/workspaces/${ws.id}/channels/${gen.id}/messages`, { body: `@${agent.handle} me ajuda?` });
    const msgs = await messages(zeca, ws.id, gen.id);
    expect(msgs.at(-1)).toMatchObject({ author: { type: "system" } });
    expect(msgs.at(-1)!.body).toBe(`Você não tem permissão para falar com Marcos (@${agent.handle}).`);
    expect(await jobs(owner, ws.id, `?agentId=${agent.id}`)).toHaveLength(0);

    // Liberado para Zeca: cria job
    await owner.patch(`/api/workspaces/${ws.id}/agents/${agent.id}`, { allowedUserIds: [zeca.userId] });
    await zeca.post(`/api/workspaces/${ws.id}/channels/${gen.id}/messages`, { body: `@${agent.handle} agora sim?` });
    expect(await jobs(owner, ws.id, `?agentId=${agent.id}`)).toHaveLength(1);

    // Assistente pessoal só responde ao dono
    const assistant = b.agents.find((a) => a.isAssistant && a.ownerUserId === owner.userId)!;
    await zeca.post(`/api/workspaces/${ws.id}/channels/${gen.id}/messages`, { body: `@${assistant.handle} oi` });
    const last = (await messages(zeca, ws.id, gen.id)).at(-1)!;
    expect(last.author.type).toBe("system");
    expect(last.body).toMatch(/assistente pessoal/);

    // Agente pausado
    await owner.patch(`/api/workspaces/${ws.id}/agents/${agent.id}`, { status: "paused" });
    await zeca.post(`/api/workspaces/${ws.id}/channels/${gen.id}/messages`, { body: `@${agent.handle} e agora?` });
    expect((await messages(zeca, ws.id, gen.id)).at(-1)!.body).toMatch(/está pausado/);
    expect(await jobs(owner, ws.id, `?agentId=${agent.id}`)).toHaveLength(1);
  });

  it("só admin muda orçamento; orçamento esgotado bloqueia e aviso de 80% sai uma vez", async () => {
    const { owner, ws, agent } = await setup();
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    const member = await signup("Mara", inv.body.code);
    const own = await member.post<AgentDTO>(`/api/workspaces/${ws.id}/agents`, { handle: uniq("bot").slice(0, 30), name: "Bot" });
    expect((await member.patch(`/api/workspaces/${ws.id}/agents/${own.body.id}`, { budgetRunsMonth: 10 })).status).toBe(403);

    expect((await owner.patch(`/api/workspaces/${ws.id}/agents/${agent.id}`, { budgetRunsMonth: 5 })).status).toBe(200);
    const dm = await openDm(owner, ws.id, agent.id);
    for (let i = 0; i < 5; i++) {
      await owner.post(`/api/workspaces/${ws.id}/channels/${dm.id}/messages`, { body: `pedido ${i}` });
    }
    expect(await jobs(owner, ws.id, `?agentId=${agent.id}`)).toHaveLength(5);
    await owner.post(`/api/workspaces/${ws.id}/channels/${dm.id}/messages`, { body: "mais um" });
    expect(await jobs(owner, ws.id, `?agentId=${agent.id}`)).toHaveLength(5);
    const last = (await messages(owner, ws.id, dm.id)).at(-1)!;
    expect(last.author.type).toBe("system");
    expect(last.body).toMatch(/atingiu o orçamento do mês/);
    const notes = await owner.get<{ items: { kind: string }[] }>(`/api/workspaces/${ws.id}/notifications`);
    expect(notes.body.items.filter((n) => n.kind === "budget")).toHaveLength(1);
  });

  it("trabalho autoiniciado nasce awaiting_approval e roda depois de aprovado", async () => {
    const { owner, ws, agent } = await setup();
    const token = await createRunnerToken(owner, ws.id);
    const { sock } = await connectRunner(token, ws.id);
    const row = (await env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(agent.id).first<AgentRow>())!;
    const job = await createJob(workerCtx(env, ws.id), { agent: row, origin: "routine", prompt: "Resumo de PRs" });
    expect(job.status).toBe("awaiting_approval");
    const a = await owner.get<AgentDTO>(`/api/workspaces/${ws.id}/agents/${agent.id}`);
    expect(a.body.activity).toBe("waiting_approval");

    const approvals = await owner.get<{ items: ApprovalDTO[] }>(`/api/workspaces/${ws.id}/approvals?status=pending`);
    const approval = approvals.body.items.find((x) => x.jobId === job.id)!;
    expect(approval).toMatchObject({ kind: "job_start", approverUserId: owner.userId, status: "pending" });
    const b = await bootstrap(owner, ws.id);
    expect(b.pendingApprovals.map((x) => x.id)).toContain(approval.id);
    expect(sock.received.some((m) => m.type === "job.assign")).toBe(false);

    // Outro membro não decide
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    const other = await signup("Outro", inv.body.code);
    expect((await other.post(`/api/workspaces/${ws.id}/approvals/${approval.id}/decide`, { decision: "approved" })).status).toBe(403);

    const decided = await owner.post<ApprovalDTO>(`/api/workspaces/${ws.id}/approvals/${approval.id}/decide`, { decision: "approved" });
    expect(decided.body.status).toBe("approved");
    const assign = await sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(assign.assignment).toMatchObject({ jobId: job.id, origin: "routine", prompt: "Resumo de PRs", channel: null });
    expect((await owner.post(`/api/workspaces/${ws.id}/approvals/${approval.id}/decide`, { decision: "rejected" })).status).toBe(409);

    // Com selfStartPolicy = 'run' nasce queued
    await owner.patch(`/api/workspaces/${ws.id}/agents/${agent.id}`, { selfStartPolicy: "run" });
    const row2 = (await env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(agent.id).first<AgentRow>())!;
    const job2 = await createJob(workerCtx(env, ws.id), { agent: row2, origin: "routine", prompt: "Outro resumo" });
    expect(job2.status).toBe("queued");
    sock.close();
  });
});
