import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { AgentDTO, ApprovalDTO, ChannelDTO, HubToRunner, JobDTO, MemoryDTO, MessageDTO, RoutineDTO, TaskDTO, WikiPageDTO } from "@puxibot/shared";
import { bootstrap, call, connectRunner, createAgentFor, createRunnerToken, createWorkspace, eventually, runningJob, signup, tokenReq, uniq } from "./helpers";

type Assign = Extract<HubToRunner, { type: "job.assign" }>;

async function setup() {
  const owner = await signup("Renato Lima");
  const ws = await createWorkspace(owner);
  const agent = await createAgentFor(owner, ws.id, "Marcos");
  const job = await runningJob(owner, ws.id, agent.id, "faça coisas");
  return { owner, ws, agent, job, base: `/api/workspaces/${ws.id}` };
}

describe("API de ferramentas", () => {
  it("exige token de job válido e job em execução", async () => {
    const { job, owner, ws } = await setup();
    expect((await tokenReq("tbj_lixo.assinatura", "GET", "/api/tool/channels")).status).toBe(401);
    expect((await call("/api/tool/channels")).status).toBe(401);
    expect((await tokenReq(job.token, "GET", "/api/tool/channels")).status).toBe(200);
    await owner.post(`/api/workspaces/${ws.id}/jobs/${job.jobId}/cancel`);
    const after = await tokenReq<{ error: { message: string } }>(job.token, "GET", "/api/tool/channels");
    expect(after.status).toBe(401);
  });

  it("permissões none/read/write por ferramenta com 403 claro", async () => {
    const { owner, ws, agent, job, base } = await setup();
    const t = job.token;
    // write (padrão): lê e escreve
    expect((await tokenReq(t, "GET", "/api/tool/tasks")).status).toBe(200);
    const created = await tokenReq<TaskDTO>(t, "POST", "/api/tool/tasks", { title: "Tarefa do agente", assigneeUser: "Renato Lima" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ createdBy: { type: "agent", id: agent.id }, onBehalfOfUserId: owner.userId, assignee: { type: "user", id: owner.userId } });

    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { tasks: "read", memory: "none" } });
    // PATCH de toolPerms faz merge: as outras continuam write.
    const dto = (await owner.get<AgentDTO>(`${base}/agents/${agent.id}`)).body;
    expect(dto.toolPerms).toMatchObject({ tasks: "read", memory: "none", wiki: "write", messages: "write" });

    expect((await tokenReq(t, "GET", "/api/tool/tasks")).status).toBe(200);
    const denied = await tokenReq<{ error: { code: string; message: string } }>(t, "POST", "/api/tool/tasks", { title: "não pode" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("tool_permission_denied");
    expect(denied.body.error.message).toMatch(/Marcos não tem permissão para alterar tarefas/);
    expect((await tokenReq(t, "PATCH", `/api/tool/tasks/${created.body.number}`, { status: "done" })).status).toBe(403);
    const memRead = await tokenReq<{ error: { message: string } }>(t, "GET", "/api/tool/memories");
    expect(memRead.status).toBe(403);
    expect(memRead.body.error.message).toMatch(/ler memória/);
    expect((await tokenReq(t, "POST", "/api/tool/memories", { scope: "team", content: "x" })).status).toBe(403);
    // Sempre permitidos
    expect((await tokenReq(t, "POST", "/api/tool/progress", { summary: "andando" })).status).toBe(201);
    // Busca sem tasks:read não traz tarefas.
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { tasks: "none" } });
    const search = await tokenReq<{ tasks: TaskDTO[] }>(t, "GET", "/api/tool/search?q=Tarefa");
    expect(search.status).toBe(200);
    expect(search.body.tasks).toEqual([]);
    void ws;
  });

  it("agente não lê canal privado de que não é membro nem canal humansOnly; lê o canal do job", async () => {
    const { owner, agent, job, base } = await setup();
    const t = job.token;
    const priv = await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("diretoria"), isPrivate: true });
    const humans = await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("pessoas"), humansOnly: true });
    await owner.post(`${base}/channels/${priv.body.id}/messages`, { body: "salários segredo-xyz" });
    await owner.post(`${base}/channels/${humans.body.id}/messages`, { body: "fofoca segredo-xyz" });

    for (const ref of [priv.body.id, priv.body.name!, humans.body.id, `#${humans.body.name}`]) {
      const r = await tokenReq(t, "GET", `/api/tool/messages?channel=${encodeURIComponent(ref)}`);
      expect(r.status).toBe(404);
      expect((await tokenReq(t, "POST", "/api/tool/messages", { channel: ref, body: "oi" })).status).toBe(404);
    }
    const channels = await tokenReq<{ items: { id: string }[] }>(t, "GET", "/api/tool/channels");
    const ids = channels.body.items.map((c) => c.id);
    expect(ids).not.toContain(priv.body.id);
    expect(ids).not.toContain(humans.body.id);
    expect(ids).toContain(job.dmId);
    const search = await tokenReq<{ messages: MessageDTO[] }>(t, "GET", "/api/tool/search?q=segredo-xyz");
    expect(search.body.messages).toEqual([]);
    // A pessoa vê as duas na busca.
    const mine = await owner.get<{ messages: MessageDTO[] }>(`${base}/search?q=segredo-xyz`);
    expect(mine.body.messages).toHaveLength(2);

    // Virando membro do privado, passa a ler.
    await owner.post(`${base}/channels/${priv.body.id}/members`, { member: { type: "agent", id: agent.id } });
    const now = await tokenReq<{ items: (MessageDTO & { authorName: string })[] }>(t, "GET", `/api/tool/messages?channel=${priv.body.name}`);
    expect(now.status).toBe(200);
    expect(now.body.items.map((m) => m.authorName)).toEqual(["Renato Lima"]);
    // Sem `channel`: lê a conversa do job.
    const own = await tokenReq<{ channel: { id: string }; items: MessageDTO[] }>(t, "GET", "/api/tool/messages");
    expect(own.body.channel.id).toBe(job.dmId);
    expect(own.body.items.map((m) => m.body)).toContain("faça coisas");
  });

  it("enviar mensagem (canal, pessoa, agente) registra on_behalf_of; memória, wiki, drive e time", async () => {
    const { owner, agent, job, base } = await setup();
    const t = job.token;
    const sent = await tokenReq<MessageDTO>(t, "POST", "/api/tool/messages", {
      channel: "general",
      body: "Deploy feito",
      cards: [{ type: "stats", items: [{ label: "Testes", value: "120" }] }],
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ author: { type: "agent", id: agent.id }, onBehalfOfUserId: owner.userId, jobId: job.jobId });
    expect(sent.body.cards[0]!.type).toBe("stats");
    const dm = await tokenReq<MessageDTO>(t, "POST", "/api/tool/messages", { toUser: "renato", body: "Oi Renato" });
    expect(dm.status).toBe(201);
    expect((await tokenReq(t, "POST", "/api/tool/messages", { body: "sem destino" })).status).toBe(400);
    const notes = await owner.get<{ items: { kind: string; title: string }[] }>(`${base}/notifications`);
    expect(notes.body.items.some((n) => n.kind === "dm" && n.title === "Marcos mandou uma mensagem")).toBe(true);

    const mem = await tokenReq<MemoryDTO>(t, "POST", "/api/tool/memories", { scope: "agent", content: "Renato prefere respostas curtas" });
    expect(mem.status).toBe(201);
    await tokenReq(t, "POST", "/api/tool/memories", { scope: "team", content: "O deploy é às sextas" });
    const found = await tokenReq<{ items: { id: string; scope: string }[] }>(t, "GET", "/api/tool/memories?q=deploy");
    expect(found.body.items.map((m) => m.scope)).toEqual(["team"]);
    expect((await tokenReq<{ items: unknown[] }>(t, "GET", "/api/tool/memories")).body.items).toHaveLength(2);
    expect((await tokenReq(t, "DELETE", `/api/tool/memories/${mem.body.id}`)).status).toBe(200);
    // Memória do time aparece para as pessoas.
    expect((await owner.get<{ items: MemoryDTO[] }>(`${base}/memories`)).body.items.map((m) => m.content)).toEqual(["O deploy é às sextas"]);

    const page = await tokenReq<WikiPageDTO & { created: boolean }>(t, "PUT", "/api/tool/wiki", { title: "Deploy", body: "Sextas.", parentTitle: "Processos" });
    expect(page.status).toBe(201);
    expect(page.body).toMatchObject({ created: true, onBehalfOfUserId: owner.userId, updatedBy: { type: "agent", id: agent.id } });
    const again = await tokenReq<WikiPageDTO & { created: boolean }>(t, "PUT", "/api/tool/wiki", { title: "deploy", body: "Sextas, 17h.", note: "horário" });
    expect(again.body).toMatchObject({ created: false, version: 2, id: page.body.id });
    const read = await tokenReq<WikiPageDTO>(t, "GET", `/api/tool/wiki/${encodeURIComponent("Deploy")}`);
    expect(read.body.body).toBe("Sextas, 17h.");
    const reads = await env.DB.prepare("SELECT reader_type, reader_id FROM wiki_reads WHERE page_id = ?").bind(page.body.id).all();
    expect(reads.results).toEqual([{ reader_type: "agent", reader_id: agent.id }]);
    expect((await tokenReq<{ items: { title: string }[] }>(t, "GET", "/api/tool/wiki")).body.items.map((p) => p.title).sort()).toEqual(["Deploy", "Processos"]);

    const form = new FormData();
    form.set("file", new File(["a,b\n1,2\n"], "dados.csv", { type: "text/csv" }));
    form.set("inDrive", "true");
    const up = await call("/api/tool/files", { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: form });
    expect(up.status).toBe(201);
    const file = (await up.json()) as { id: string; author: { type: string }; onBehalfOfUserId: string };
    expect(file.author.type).toBe("agent");
    expect(file.onBehalfOfUserId).toBe(owner.userId);
    expect((await tokenReq<{ items: { id: string }[] }>(t, "GET", "/api/tool/files?q=dados")).body.items.map((f) => f.id)).toEqual([file.id]);
    const dl = await call(`/api/tool/files/${file.id}/content`, { headers: { Authorization: `Bearer ${t}` } });
    expect(await dl.text()).toBe("a,b\n1,2\n");

    const team = await tokenReq<{ people: { name: string; handle: string }[]; agents: { handle: string; isMe: boolean }[] }>(t, "GET", "/api/tool/team");
    expect(team.body.people.map((p) => p.name)).toEqual(["Renato Lima"]);
    expect(team.body.agents.find((a) => a.isMe)?.handle).toBe(agent.handle);
  });

  it("revisão automática de memória: guarda, apaga só o que não é de pessoa, vale por pouco tempo depois do fim", async () => {
    const { owner, agent, job, base, ws } = await setup();
    const t = job.token;
    // Uma memória escrita por uma pessoa, uma do próprio agente e uma de outro agente.
    const human = await owner.post<MemoryDTO>(`${base}/memories`, { content: "Regra escrita pela pessoa" });
    expect(human.status).toBe(201);
    const mine = await tokenReq<MemoryDTO>(t, "POST", "/api/tool/memories", { scope: "team", content: "O Acme paga no dia 5" });
    const other = await createAgentFor(owner, ws.id, "Tito");
    const otherMem = await owner.post<MemoryDTO>(`${base}/agents/${other.id}/memories`, { content: "Memória do Tito" });
    expect(otherMem.status).toBe(201);

    // As memórias vão no trabalho com id e a marca de removível.
    const sent = job.assignment.memories;
    expect(sent.every((m) => typeof m.id === "string")).toBe(true);

    // O trabalho termina; a revisão chega logo depois.
    job.sock.send({ type: "job.done", jobId: job.jobId, text: "Anotado.", inputTokens: 100, outputTokens: 10, model: "haiku" });
    await eventually(async () => {
      const r = await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agent.id}`);
      return r.body.items.find((j) => j.id === job.jobId && j.status === "done");
    });
    // Fora das duas chamadas da revisão (ler as memórias e mandar o resultado), o token não vale mais.
    expect((await tokenReq(t, "POST", "/api/tool/memories", { scope: "team", content: "x" })).status).toBe(401);
    expect((await tokenReq(t, "DELETE", `/api/tool/memories/${mine.body.id}`)).status).toBe(401);
    expect((await tokenReq(t, "GET", "/api/tool/channels")).status).toBe(401);
    const current = await tokenReq<{ items: { id: string; source: string }[] }>(t, "GET", "/api/tool/memories");
    expect(current.status).toBe(200);
    expect(current.body.items.find((m) => m.id === human.body.id)!.source).toBe("user");

    const review = await tokenReq<{ added: number; removed: number }>(t, "POST", "/api/tool/memories/review", {
      add: [
        // Cada mudança leva um trecho literal do pedido da pessoa ("faça coisas"); o hub confere no banco.
        { scope: "team", content: "O Acme paga no dia 20", quote: "faça coisas" },
        { scope: "team", content: "regra escrita pela pessoa", quote: "faça coisas" }, // repetida (só muda a caixa): não entra de novo
      ],
      remove: [mine.body.id, human.body.id, otherMem.body.id].map((id) => ({ id, quote: "faça coisas" })),
      usage: { inputTokens: 700, outputTokens: 40 },
    });
    expect(review.status).toBe(200);
    expect(review.body).toEqual({ added: 1, removed: 1 });

    const team = await owner.get<{ items: MemoryDTO[] }>(`${base}/memories`);
    expect(team.body.items.map((m) => m.content).sort()).toEqual(["O Acme paga no dia 20", "Regra escrita pela pessoa"]);
    expect(team.body.items.find((m) => m.content === "O Acme paga no dia 20")!.source).toBe("extraction");
    expect((await owner.get<{ items: MemoryDTO[] }>(`${base}/agents/${other.id}/memories`)).body.items).toHaveLength(1);

    // O custo entra no trabalho e a mudança fica registrada nele.
    const after = await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agent.id}`);
    expect(after.body.items.find((j) => j.id === job.jobId)).toMatchObject({ inputTokens: 800, outputTokens: 50 });
    const events = await env.DB.prepare("SELECT summary FROM job_events WHERE job_id = ?").bind(job.jobId).all<{ summary: string }>();
    const note = events.results.find((e) => e.summary.startsWith("Memória revisada."))!;
    expect(note.summary).toContain("+ O Acme paga no dia 20");
    expect(note.summary).toContain("− O Acme paga no dia 5");

    // Limites por trabalho e tamanho do texto.
    expect((await tokenReq(t, "POST", "/api/tool/memories/review", { add: Array.from({ length: 4 }, (_, i) => ({ scope: "agent", content: `f${i}` })) })).status).toBe(400);
    expect((await tokenReq(t, "POST", "/api/tool/memories/review", { add: [{ scope: "agent", content: "x".repeat(501) }] })).status).toBe(400);

    // Passada a janela, nem a revisão é aceita.
    await env.DB.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").bind(Date.now() - 10 * 60_000, job.jobId).run();
    expect((await tokenReq(t, "POST", "/api/tool/memories/review", { add: [], remove: [] })).status).toBe(401);
    expect((await tokenReq(t, "GET", "/api/tool/memories")).status).toBe(401);
  });

  it("revisão automática de memória exige permissão de escrita em memória", async () => {
    const { owner, agent, job, base } = await setup();
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { memory: "read" } });
    const r = await tokenReq(job.token, "POST", "/api/tool/memories/review", { add: [{ scope: "team", content: "x" }] });
    expect(r.status).toBe(403);
  });

  it("tarefas pela ferramenta: atribuir a outro agente cria job filho com a tarefa; comentário com menção", async () => {
    const { owner, ws, job, base } = await setup();
    const tito = await createAgentFor(owner, ws.id, "Tito");
    const t = job.token;
    const task = await tokenReq<TaskDTO>(t, "POST", "/api/tool/tasks", { title: "Revisar PR", assigneeAgent: tito.handle, priority: "high" });
    expect(task.status).toBe(201);
    const jobs = (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${tito.id}`)).body.items;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ origin: "agent", parentJobId: job.jobId, requestedByUserId: owner.userId, taskId: task.body.id });
    const upd = await tokenReq<TaskDTO>(t, "PATCH", `/api/tool/tasks/${task.body.number}`, {
      status: "review",
      subtasks: [{ title: "ler diff", done: true }],
      links: [{ kind: "pr", label: "PR 7", url: "https://github.com/o/r/pull/7" }],
    });
    expect(upd.body).toMatchObject({ status: "review", subtasks: [{ title: "ler diff", done: true }] });
    const cm = await tokenReq(t, "POST", `/api/tool/tasks/${task.body.number}/comments`, { body: "feito" });
    expect(cm.status).toBe(201);
    expect((await tokenReq(t, "PATCH", "/api/tool/tasks/9999", { status: "done" })).status).toBe(404);
    const list = await tokenReq<{ items: TaskDTO[] }>(t, "GET", `/api/tool/tasks?assignee=${tito.handle}&status=review`);
    expect(list.body.items.map((x) => x.id)).toEqual([task.body.id]);
  });

  it("consultar_agente cria job filho, espera o runner falso responder e devolve { text }; respeita as regras", async () => {
    const { owner, ws, agent, job, base } = await setup();
    const tito = await createAgentFor(owner, ws.id, "Tito");
    const t = job.token;
    const asking = tokenReq<{ text: string; status: string; jobId: string }>(t, "POST", `/api/tool/agents/${tito.handle}/ask`, { prompt: "Qual o status do deploy?" });
    const child = await job.sock.waitFor<Assign>((m) => m.type === "job.assign" && m.assignment.agent.id === tito.id);
    expect(child.assignment.origin).toBe("agent");
    expect(child.assignment.prompt).toContain("Qual o status do deploy?");
    expect(child.assignment.requestedBy?.userId).toBe(owner.userId);
    job.sock.send({ type: "job.accepted", jobId: child.assignment.jobId, cli: "claude", model: "haiku" });
    job.sock.send({ type: "job.done", jobId: child.assignment.jobId, text: "Está verde.", inputTokens: 1, outputTokens: 1, model: "haiku" });
    const answer = await asking;
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ text: "Está verde.", status: "done", jobId: child.assignment.jobId });
    const row = await env.DB.prepare("SELECT parent_job_id, origin FROM jobs WHERE id = ?").bind(child.assignment.jobId).first();
    expect(row).toEqual({ parent_job_id: job.jobId, origin: "agent" });

    // Ciclo: Tito (em execução em nome de Marcos) consultando Marcos.
    const theoAsk = tokenReq(t, "POST", `/api/tool/agents/${tito.handle}/ask`, { prompt: "pergunta 2" });
    const child2 = await job.sock.waitFor<Assign>((m) => m.type === "job.assign" && m.assignment.agent.id === tito.id && m.assignment.jobId !== child.assignment.jobId);
    job.sock.send({ type: "job.accepted", jobId: child2.assignment.jobId, cli: "claude", model: "haiku" });
    await eventually(async () => (await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(child2.assignment.jobId).first<{ status: string }>())?.status === "running");
    const cycle = await tokenReq<{ error: { code: string } }>(child2.assignment.jobToken, "POST", `/api/tool/agents/${agent.handle}/ask`, { prompt: "e aí?" });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.code).toBe("consult_cycle");
    job.sock.send({ type: "job.done", jobId: child2.assignment.jobId, text: "ok", inputTokens: 1, outputTokens: 1, model: "haiku" });
    expect((await theoAsk).status).toBe(200);

    // Alvo não aceita consultas; chamador com lista "only".
    await owner.patch(`${base}/agents/${tito.id}`, { agentsCanConsult: false });
    const denied = await tokenReq<{ error: { message: string } }>(t, "POST", `/api/tool/agents/${tito.handle}/ask`, { prompt: "x" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/não aceita consultas/);
    await owner.patch(`${base}/agents/${tito.id}`, { agentsCanConsult: true });
    await owner.patch(`${base}/agents/${agent.id}`, { callableAgentsMode: "only", callableAgentIds: [] });
    expect((await tokenReq(t, "POST", `/api/tool/agents/${tito.handle}/ask`, { prompt: "x" })).status).toBe(403);
    await owner.patch(`${base}/agents/${agent.id}`, { callableAgentsMode: "all", toolPerms: { agents: "read" } });
    expect((await tokenReq(t, "POST", `/api/tool/agents/${tito.handle}/ask`, { prompt: "x" })).status).toBe(403);
    expect((await tokenReq(t, "POST", `/api/tool/agents/naoexiste/ask`, { prompt: "x" })).status).toBe(403);
  });

  it("consultar_agente com capacidade 1: o filho vai ao runner do pai acima da capacidade, com parentJobId", async () => {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const marcos = await createAgentFor(owner, ws.id, "Marcos");
    const tito = await createAgentFor(owner, ws.id, "Tito");
    const conn = await connectRunner(await createRunnerToken(owner, ws.id), ws.id, { capacity: 1 });
    const job = await runningJob(owner, ws.id, marcos.id, "pergunte ao Tito", conn);
    const asking = tokenReq<{ text: string; status: string }>(job.token, "POST", `/api/tool/agents/${tito.handle}/ask`, { prompt: "oi", queueTimeoutMs: 5000 });
    const child = await conn.sock.waitFor<Assign>((m) => m.type === "job.assign" && m.assignment.agent.id === tito.id);
    expect(child.assignment.parentJobId).toBe(job.jobId);
    conn.sock.send({ type: "job.accepted", jobId: child.assignment.jobId, cli: "claude", model: "haiku" });
    conn.sock.send({ type: "job.done", jobId: child.assignment.jobId, text: "oi, Marcos", inputTokens: 1, outputTokens: 1, model: "haiku" });
    expect((await asking).body).toMatchObject({ status: "done", text: "oi, Marcos" });
  });

  it("consultar_agente desiste (no_runner) quando nenhum runner pega o filho, sem travar o pai", async () => {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const marcos = await createAgentFor(owner, ws.id, "Marcos");
    // Nenhum runner tem a CLI preferida do Tito: o filho fica sem runner.
    const tito = await createAgentFor(owner, ws.id, "Tito");
    await owner.patch(`/api/workspaces/${ws.id}/agents/${tito.id}`, { preferredCli: "gemini" });
    const conn = await connectRunner(await createRunnerToken(owner, ws.id), ws.id, { capacity: 1 });
    const job = await runningJob(owner, ws.id, marcos.id, "pergunte ao Tito", conn);
    const res = await tokenReq<{ text: string; status: string; note: string; jobId: string }>(job.token, "POST", `/api/tool/agents/${tito.handle}/ask`, {
      prompt: "oi",
      queueTimeoutMs: 300,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "no_runner", text: "" });
    expect(res.body.note).toMatch(/Nenhum computador/);
    const child = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(res.body.jobId).first<{ status: string }>();
    expect(child?.status).toBe("cancelled");
  });

  it("pedir_aprovacao cria aprovação action para o responsável e o GET mostra a decisão", async () => {
    const { owner, job, base } = await setup();
    const created = await tokenReq<ApprovalDTO>(job.token, "POST", "/api/tool/approvals", { title: "Publicar post", details: "No Instagram" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "action", status: "pending", approverUserId: owner.userId, jobId: job.jobId });
    const notes = await owner.get<{ items: { kind: string; title: string; body: string | null }[] }>(`${base}/notifications`);
    expect(notes.body.items.find((n) => n.kind === "approval")).toMatchObject({ title: "Marcos pediu sua aprovação", body: "Publicar post" });
    await owner.post(`${base}/approvals/${created.body.id}/decide`, { decision: "approved", note: "pode" });
    const got = await tokenReq<ApprovalDTO>(job.token, "GET", `/api/tool/approvals/${created.body.id}`);
    expect(got.body).toMatchObject({ id: created.body.id, status: "approved", decisionNote: "pode" });
  });

  it("criar_agente e criar_rotina só para o assistente pessoal agindo como o dono", async () => {
    const { owner, ws, job, base } = await setup();
    const denied = await tokenReq<{ error: { code: string } }>(job.token, "POST", "/api/tool/agents", { handle: "novo", name: "Novo" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("assistant_only");

    const boot = await bootstrap(owner, ws.id);
    const assistant = boot.agents.find((a) => a.isAssistant && a.ownerUserId === owner.userId)!;
    const aj = await runningJob(owner, ws.id, assistant.id, "crie um agente", { sock: job.sock });
    const made = await tokenReq<AgentDTO>(aj.token, "POST", "/api/tool/agents", { handle: uniq("lia").slice(0, 20), name: "Lia", role: "PM" });
    expect(made.status).toBe(201);
    expect(made.body.ownerUserId).toBe(owner.userId);
    const routine = await tokenReq<RoutineDTO>(aj.token, "POST", "/api/tool/routines", {
      agent: made.body.handle,
      name: "Resumo de PRs",
      prompt: "Resuma os PRs",
      cron: "4 9 * * 1-5",
      timezone: "America/Sao_Paulo",
      channel: "general",
    });
    expect(routine.status).toBe(201);
    expect(routine.body.nextRunAt).toBeGreaterThan(Date.now());
    expect(routine.body.agentId).toBe(made.body.id);
    expect((await tokenReq(aj.token, "POST", "/api/tool/routines", { name: "x", prompt: "y", cron: "bad" })).status).toBe(400);
    expect((await owner.get<{ items: RoutineDTO[] }>(`${base}/routines?agentId=${made.body.id}`)).body.items).toHaveLength(1);
  });
});
