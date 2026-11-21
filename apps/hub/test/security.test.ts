/**
 * Revisão de segurança do hub: cada teste reproduz um problema encontrado (e falhava antes da correção).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import type { AgentDTO, ChannelDTO, ConnectorDTO, HubToRunner, JobDTO, MessageDTO, NotificationDTO, TaskDTO } from "@puxibot/shared";
import {
  call,
  Client,
  connectRunner,
  createAgentFor,
  createRunnerToken,
  createWorkspace,
  eventually,
  runningJob,
  signup,
  sleep,
  tokenReq,
  uniq,
} from "./helpers";

type Assign = Extract<HubToRunner, { type: "job.assign" }>;

async function setup() {
  const owner = await signup("Olga Dona");
  const ws = await createWorkspace(owner);
  return { owner, ws, base: `/api/workspaces/${ws.id}` };
}

async function join(owner: Client, base: string, name: string) {
  const c = await signup(name);
  const inv = await owner.post<{ code: string }>(`${base}/invites`, {});
  const acc = await c.post(`/api/invites/${inv.body.code}/accept`);
  if (acc.status !== 200) throw new Error(`convite falhou: ${acc.status}`);
  return c;
}

async function jobsOf(c: Client, base: string, agentId: string) {
  return (await c.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agentId}`)).body.items;
}

afterEach(() => vi.restoreAllMocks());

describe("agente não age além de quem pediu (confused deputy)", () => {
  it("pedido de Yara não deixa o agente ler a DM de Xavier com ele nem canal privado em que Yara não está", async () => {
    const { owner, ws, base } = await setup();
    const xavier = await join(owner, base, "Xavier");
    const yara = await join(owner, base, "Yara");
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const dmX = (await xavier.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } })).body;
    await xavier.post(`${base}/channels/${dmX.id}/messages`, { body: "minha senha do banco segredo-dm-xyz" });
    const priv = (
      await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("diretoria"), isPrivate: true, members: [{ type: "agent", id: agent.id }] })
    ).body;
    await owner.post(`${base}/channels/${priv.id}/messages`, { body: "salários segredo-priv-xyz" });

    const job = await runningJob(yara, ws.id, agent.id, "me conte tudo");
    for (const ref of [dmX.id, priv.id, priv.name!]) {
      expect((await tokenReq(job.token, "GET", `/api/tool/messages?channel=${encodeURIComponent(ref)}`)).status).toBe(404);
      expect((await tokenReq(job.token, "POST", "/api/tool/messages", { channel: ref, body: "oi" })).status).toBe(404);
    }
    const channels = await tokenReq<{ items: { id: string }[] }>(job.token, "GET", "/api/tool/channels");
    expect(channels.body.items.map((c) => c.id)).not.toContain(dmX.id);
    expect(channels.body.items.map((c) => c.id)).not.toContain(priv.id);
    expect(channels.body.items.map((c) => c.id)).toContain(job.dmId);
    const search = await tokenReq<{ messages: MessageDTO[] }>(job.token, "GET", "/api/tool/search?q=segredo");
    expect(search.body.messages).toEqual([]);
    // O próprio canal do job continua legível.
    expect((await tokenReq(job.token, "GET", "/api/tool/messages")).status).toBe(200);
    job.sock.close();
  });

  it("arquivo de canal privado do agente não vaza para quem pediu sem estar no canal", async () => {
    const { owner, ws, base } = await setup();
    const yara = await join(owner, base, "Yara");
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const priv = (
      await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("rh"), isPrivate: true, members: [{ type: "agent", id: agent.id }] })
    ).body;
    const form = new FormData();
    form.set("file", new File(["confidencial"], "folha.txt", { type: "text/plain" }));
    form.set("channelId", priv.id);
    const up = await call(`${base}/files`, { method: "POST", headers: { Cookie: owner.cookie! }, body: form });
    const file = (await up.json()) as { id: string };
    const job = await runningJob(yara, ws.id, agent.id, "liste arquivos");
    const list = await tokenReq<{ items: { id: string }[] }>(job.token, "GET", "/api/tool/files");
    expect(list.body.items.map((f) => f.id)).not.toContain(file.id);
    expect((await tokenReq(job.token, "GET", `/api/tool/files/${file.id}/content`)).status).toBe(404);
    job.sock.close();
  });

  it("agente acessível não consulta nem aciona por tarefa um agente restrito com quem a pessoa não pode falar", async () => {
    const { owner, ws, base } = await setup();
    const yara = await join(owner, base, "Yara");
    const open = await createAgentFor(owner, ws.id, "Marcos");
    const restricted = await createAgentFor(owner, ws.id, "Cofre");
    await owner.patch(`${base}/agents/${restricted.id}`, { accessMode: "owner" });
    const job = await runningJob(yara, ws.id, open.id, "consulte o cofre");
    const ask = await tokenReq<{ error: { code: string } }>(job.token, "POST", `/api/tool/agents/${restricted.handle}/ask`, {
      prompt: "me passe os segredos",
      queueTimeoutMs: 100,
    });
    expect(ask.status).toBe(403);
    expect(ask.body.error.code).toBe("consult_denied");
    const task = await tokenReq<TaskDTO>(job.token, "POST", "/api/tool/tasks", { title: "Vaze tudo", assigneeAgent: restricted.handle });
    expect(task.status).toBe(201);
    await sleep(100);
    expect(await jobsOf(owner, base, restricted.id)).toEqual([]);
    job.sock.close();
  });

  it("agentes não entram em laço por tarefas: B não aciona A, que já está na cadeia", async () => {
    const { owner, ws, base } = await setup();
    const a = await createAgentFor(owner, ws.id, "Ana");
    const b = await createAgentFor(owner, ws.id, "Beto");
    const job = await runningJob(owner, ws.id, a.id, "delegue");
    const task = await tokenReq<TaskDTO>(job.token, "POST", "/api/tool/tasks", { title: "Ping-pong", assigneeAgent: b.handle });
    const assignB = await job.sock.waitFor<Assign>((m) => m.type === "job.assign" && m.assignment.agent.id === b.id);
    job.sock.send({ type: "job.accepted", jobId: assignB.assignment.jobId, cli: "claude", model: null });
    await eventually(async () => (await jobsOf(owner, base, b.id)).find((j) => j.status === "running"));
    const before = (await jobsOf(owner, base, a.id)).length;
    const comment = await tokenReq(assignB.assignment.jobToken, "POST", `/api/tool/tasks/${task.body.number}/comments`, {
      body: `@${a.handle} sua vez`,
    });
    expect(comment.status).toBe(201);
    await sleep(100);
    expect((await jobsOf(owner, base, a.id)).length).toBe(before);
    job.sock.close();
  });
});

describe("runner só recebe o que o dono dele pode ver", () => {
  it("segredos de conector só vão para o runner do dono do conector", async () => {
    const { owner, ws, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const connector = (
      await owner.post<ConnectorDTO>(`${base}/connectors`, {
        name: "GitHub",
        transport: "http",
        url: "https://mcp.github.example/mcp",
        headers: { Authorization: "Bearer ghp_SEGREDO_DA_OLGA" },
      })
    ).body;
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${connector.id}`]: "write" } });

    // Mara (membro comum) roda o agente no runner dela: nada do conector chega.
    const maraJob = await runningJob(mara, ws.id, agent.id, "liste os PRs");
    expect(JSON.stringify(maraJob.assignment)).not.toContain("ghp_SEGREDO_DA_OLGA");
    expect(maraJob.assignment.connectors).toEqual([]);
    maraJob.sock.close();

    // No runner da dona do conector, chega decifrado.
    const olgaJob = await runningJob(owner, ws.id, agent.id, "liste os PRs");
    expect(olgaJob.assignment.connectors.map((c) => c.headers)).toEqual([{ Authorization: "Bearer ghp_SEGREDO_DA_OLGA" }]);
    olgaJob.sock.close();
  });

  it("job da DM de Mara com o agente não vai para o runner da responsável, que não enxerga a DM", async () => {
    const { owner, ws, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const { sock } = await connectRunner(await createRunnerToken(owner, ws.id), ws.id);
    const dm = (await mara.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } })).body;
    await mara.post(`${base}/channels/${dm.id}/messages`, { body: "assunto pessoal segredo-mara" });
    const job = await eventually(async () => (await jobsOf(mara, base, agent.id)).find((j) => j.waitingForRunner));
    expect(job.status).toBe("queued");
    await sleep(100);
    expect(sock.received.some((m) => m.type === "job.assign")).toBe(false);
    // Quando Mara liga o runner dela, o job sai.
    const maraRunner = await connectRunner(await createRunnerToken(mara, ws.id), ws.id);
    const a = await maraRunner.sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(a.assignment.jobId).toBe(job.id);
    sock.close();
    maraRunner.sock.close();
  });

  it("contexto de canal privado não vai para o runner de quem não está no canal", async () => {
    const { owner, ws, base } = await setup();
    const mara = await join(owner, base, "Mara");
    // Agente de Mara; canal privado da Olga com o agente; Olga pede, só o runner de Mara está online.
    const agent = await createAgentFor(mara, ws.id, "Marcos");
    const priv = (
      await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("diretoria"), isPrivate: true, members: [{ type: "agent", id: agent.id }] })
    ).body;
    const { sock } = await connectRunner(await createRunnerToken(mara, ws.id), ws.id);
    await owner.post(`${base}/channels/${priv.id}/messages`, { body: "demissões segredo-priv" });
    await owner.post(`${base}/channels/${priv.id}/messages`, { body: `@${agent.handle} resuma` });
    await eventually(async () => (await jobsOf(owner, base, agent.id)).find((j) => j.waitingForRunner));
    await sleep(100);
    expect(sock.received.some((m) => m.type === "job.assign")).toBe(false);
    sock.close();
  });
});

describe("jobs de conversas alheias", () => {
  it("responsável e admin veem o job da DM de outra pessoa com o agente, mas sem o pedido nem os eventos", async () => {
    const { owner, ws, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const job = await runningJob(mara, ws.id, agent.id, "meu segredo-prompt-xyz");
    expect((await tokenReq(job.token, "POST", "/api/tool/progress", { summary: "lendo segredo-evento-xyz" })).status).toBe(201);
    const seen = (await jobsOf(owner, base, agent.id)).find((j) => j.id === job.jobId)!;
    expect(seen).toBeTruthy();
    expect(seen.prompt).not.toContain("segredo-prompt-xyz");
    const activity = await owner.get<{ items: (JobDTO & { events: { summary: string }[] })[] }>(`${base}/agents/${agent.id}/activity`);
    expect(JSON.stringify(activity.body)).not.toContain("segredo");
    // Quem pediu vê tudo.
    expect((await jobsOf(mara, base, agent.id)).find((j) => j.id === job.jobId)!.prompt).toContain("segredo-prompt-xyz");
    job.sock.close();
  });
});

describe("CSRF e WebSocket entre sites", () => {
  it("recusa POST/PATCH/DELETE, upload e upgrade de WebSocket com cookie vindos de outra origem", async () => {
    const { owner, ws, base } = await setup();
    const evil = { Cookie: owner.cookie!, Origin: "https://evil.example", "Content-Type": "text/plain" };
    const post = await call(`${base}/channels`, { method: "POST", headers: evil, body: JSON.stringify({ name: uniq("x") }) });
    expect(post.status).toBe(403);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe("csrf_origin");
    expect((await call(`${base}`, { method: "PATCH", headers: evil, body: JSON.stringify({ name: "Hackeado" }) })).status).toBe(403);
    const form = new FormData();
    form.set("file", new File(["x"], "x.txt"));
    expect((await call(`${base}/files`, { method: "POST", headers: { Cookie: owner.cookie!, Origin: "https://evil.example" }, body: form })).status).toBe(403);
    const wsRes = await call(`${base}/realtime`, { headers: { Upgrade: "websocket", Cookie: owner.cookie!, Origin: "https://evil.example" } });
    expect(wsRes.status).toBe(403);
    // Sec-Fetch-Site cross-site sem Origin também.
    expect((await call(`${base}/channels`, { method: "POST", headers: { Cookie: owner.cookie!, "Sec-Fetch-Site": "cross-site" }, body: "{}" })).status).toBe(403);
    // Mesma origem passa.
    const ok = await call(`${base}/channels`, {
      method: "POST",
      headers: { Cookie: owner.cookie!, Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ name: uniq("ok") }),
    });
    expect(ok.status).toBe(201);
    const wsOk = await call(`${base}/realtime`, { headers: { Upgrade: "websocket", Cookie: owner.cookie!, Origin: "http://localhost" } });
    expect(wsOk.status).toBe(101);
    wsOk.webSocket?.accept();
    wsOk.webSocket?.close();
  });
});

describe("limite de tentativas", () => {
  it("login: bloqueia por e-mail depois de 10 tentativas e por IP depois de 30", async () => {
    const email = `${uniq("alvo")}@exemplo.com`;
    const c = new Client();
    await c.post("/api/auth/signup", { email, name: "Alvo", password: "senha-forte-123" });
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const login = (password: string, from = ip, who = email) =>
      call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": from }, body: JSON.stringify({ email: who, password }) });
    for (let i = 0; i < 10; i++) expect((await login("errada")).status).toBe(401);
    const blocked = await login("senha-forte-123");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    // Outro IP também não passa (o limite é do e-mail).
    expect((await login("senha-forte-123", "198.51.100.9")).status).toBe(429);
    // Por IP: muitos e-mails diferentes do mesmo IP.
    const ip2 = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await login("x", ip2, `${uniq("n")}@exemplo.com`)).status;
    expect(last).toBe(429);
  });

  it("pareamento: start limitado por IP e approve limitado por pessoa", async () => {
    const ip = `198.18.0.${Math.floor(Math.random() * 200) + 1}`;
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (
        await call("/api/runner/pair/start", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ name: "pc" }) })
      ).status;
    }
    expect(last).toBe(429);
    const { owner, base } = await setup();
    let approve = 0;
    for (let i = 0; i < 11; i++) approve = (await owner.post(`${base}/runner/pair/approve`, { pairCode: "ZZZZ-ZZZZ" })).status;
    expect(approve).toBe(429);
  });

  it("código de pareamento usa o alfabeto todo, sem viés de módulo", async () => {
    const { randomCode } = await import("../src/lib/crypto");
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) for (const ch of randomCode().replace("-", "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(31);
    // Com `byte % 31` os 8 primeiros símbolos saem ~12% mais; a média por símbolo é ~1032.
    const first = ["A", "B", "C", "D", "E", "F", "G", "H"].reduce((s, ch) => s + (counts.get(ch) ?? 0), 0) / 8;
    const last = ["S", "T", "U", "V", "W", "X", "Y", "Z"].reduce((s, ch) => s + (counts.get(ch) ?? 0), 0) / 8;
    expect(first / last).toBeLessThan(1.08);
  });
});

describe("configuração e cabeçalhos", () => {
  it("fora de localhost, recusa funcionar com os segredos de teste/desenvolvimento", async () => {
    const res = await exports.default.fetch(new Request("https://hub.exemplo.com/api/me"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("insecure_config");
    expect(body.error.message).toMatch(/JOB_TOKEN_SECRET/);
    expect(body.error.message).not.toContain(env.JOB_TOKEN_SECRET);
  });

  it("respostas da API trazem cabeçalhos de segurança", async () => {
    const res = await call("/api/me");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("token pessoal não cria outros tokens e só vê notificações do próprio workspace", async () => {
    const { owner, ws, base } = await setup();
    const other = await createWorkspace(owner, "Outro");
    const token = (await owner.post<{ token: string }>(`${base}/tokens`, { name: "script", kind: "personal" })).body.token;
    expect((await tokenReq(token, "POST", `${base}/tokens`, { name: "runner", kind: "runner" })).status).toBe(403);
    await env.DB.prepare(
      "INSERT INTO notifications (id, workspace_id, user_id, kind, title, created_at) VALUES (?, ?, ?, 'dm', 'de outro workspace', ?)",
    )
      .bind(crypto.randomUUID(), other.id, owner.userId, Date.now())
      .run();
    const mine = await tokenReq<{ items: { workspaceId: string }[] }>(token, "GET", "/api/me/notifications");
    expect(mine.status).toBe(200);
    expect(mine.body.items.every((n) => n.workspaceId === ws.id)).toBe(true);
  });

  it("limite de workspaces criados por pessoa", async () => {
    const owner = await signup("Muitos");
    const now = Date.now();
    const stmts = [];
    for (let i = 0; i < 20; i++) {
      stmts.push(
        env.DB.prepare("INSERT INTO workspaces (id, name, kind, created_by, created_at) VALUES (?, 'x', 'team', ?, ?)").bind(crypto.randomUUID(), owner.userId, now),
      );
    }
    await env.DB.batch(stmts);
    const res = await owner.post<{ error: { code: string } }>("/api/workspaces", { name: "mais um", kind: "team" });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("workspace_limit");
  });

  it("corpo JSON gigante é recusado antes de ser lido", async () => {
    const { owner, base } = await setup();
    const res = await call(`${base}/feedback`, {
      method: "POST",
      headers: { Cookie: owner.cookie!, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x".repeat(3 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("visibilidade em canais e notificações", () => {
  it("feedback não publica em canal privado que a pessoa não enxerga", async () => {
    const { owner, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const priv = (await owner.post<ChannelDTO>(`${base}/channels`, { name: "feedbacks", isPrivate: true })).body;
    const res = await mara.post<{ channelId: string | null; messageId: string | null }>(`${base}/feedback`, { body: "@todos olhem isso" });
    expect(res.status).toBe(201);
    expect(res.body.messageId).toBeNull();
    const msgs = (await owner.get<{ items: MessageDTO[] }>(`${base}/channels/${priv.id}/messages`)).body.items;
    expect(msgs).toEqual([]);
  });

  it("anexo precisa ser visível a quem envia e não sai do canal privado de origem", async () => {
    const { owner, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const general = (await owner.get<{ items: ChannelDTO[] }>(`${base}/channels`)).body.items.find((c) => c.name === "general")!;
    const priv = (await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("priv"), isPrivate: true })).body;
    const form = new FormData();
    form.set("file", new File(["segredo"], "plano.pdf", { type: "application/pdf" }));
    form.set("channelId", priv.id);
    form.set("inDrive", "0");
    const file = (await (await call(`${base}/files`, { method: "POST", headers: { Cookie: owner.cookie! }, body: form })).json()) as { id: string };
    // Mara não enxerga o arquivo.
    expect((await mara.post(`${base}/channels/${general.id}/messages`, { body: "olha", attachmentIds: [file.id] })).status).toBe(404);
    // Nem a dona pode "mover" o anexo do canal privado para o general.
    expect((await owner.post(`${base}/channels/${general.id}/messages`, { body: "olha", attachmentIds: [file.id] })).status).toBe(404);
    // No próprio canal, pode.
    expect((await owner.post(`${base}/channels/${priv.id}/messages`, { body: "olha", attachmentIds: [file.id] })).status).toBe(201);
  });

  it("citação precisa apontar para mensagem do mesmo canal", async () => {
    const { owner, base } = await setup();
    const general = (await owner.get<{ items: ChannelDTO[] }>(`${base}/channels`)).body.items.find((c) => c.name === "general")!;
    const priv = (await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("priv"), isPrivate: true })).body;
    const secret = (await owner.post<MessageDTO>(`${base}/channels/${priv.id}/messages`, { body: "segredo" })).body;
    const res = await owner.post(`${base}/channels/${general.id}/messages`, { body: "veja", quote: { messageId: secret.id, text: "segredo" } });
    expect(res.status).toBe(404);
  });

  it("menção a quem não enxerga o canal privado não gera notificação (nem revela o nome do canal)", async () => {
    const { owner, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const me = await mara.get<{ user: { email: string } }>("/api/me");
    const handle = me.body.user.email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const priv = (await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("demissoes"), isPrivate: true })).body;
    await owner.post(`${base}/channels/${priv.id}/messages`, { body: `@${handle} vai ser demitida` });
    await sleep(50);
    const notes = (await mara.get<{ items: NotificationDTO[] }>(`${base}/notifications`)).body.items;
    expect(notes.filter((n) => n.kind === "mention")).toEqual([]);
  });

  it("rotina não publica em canal só de humanos nem em canal que o agente não enxerga", async () => {
    const { owner, ws, base } = await setup();
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const humans = (await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("pessoas"), humansOnly: true })).body;
    const priv = (await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("priv"), isPrivate: true })).body;
    for (const channelId of [humans.id, priv.id]) {
      const res = await owner.post(`${base}/routines`, { agentId: agent.id, name: "x", prompt: "y", cron: "0 9 * * *", channelId });
      expect(res.status).toBe(400);
    }
    const created = await owner.post<{ id: string }>(`${base}/routines`, { agentId: agent.id, name: "x", prompt: "y", cron: "0 9 * * *" });
    expect((await owner.patch(`${base}/routines/${created.body.id}`, { channelId: humans.id })).status).toBe(400);
  });
});

describe("conteúdo que chega à interface", () => {
  it("links de tarefa e de cartões só aceitam http(s) ou caminho relativo", async () => {
    const { owner, ws, base } = await setup();
    const bad = await owner.post(`${base}/tasks`, { title: "x", links: [{ kind: "url", label: "clique", url: "javascript:alert(document.cookie)" }] });
    expect(bad.status).toBe(400);
    const ok = await owner.post(`${base}/tasks`, { title: "x", links: [{ kind: "pr", label: "#1", url: "https://github.com/a/b/pull/1" }] });
    expect(ok.status).toBe(201);
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const job = await runningJob(owner, ws.id, agent.id, "oi");
    const card = await tokenReq(job.token, "POST", "/api/tool/messages", {
      channel: job.dmId,
      body: "veja",
      cards: [{ type: "checklist", title: "t", items: [{ label: "a", done: false, link: "javascript:alert(1)" }] }],
    });
    expect(card.status).toBe(400);
    // Cartões do job.done também passam pela validação (inválidos são descartados).
    job.sock.send({
      type: "job.done",
      jobId: job.jobId,
      text: "pronto",
      cards: [{ type: "checklist", title: "t", items: [{ label: "a", done: false, link: "javascript:alert(1)" }] }] as never,
      inputTokens: 1,
      outputTokens: 1,
      model: null,
    });
    const reply = await eventually(async () =>
      (await owner.get<{ items: MessageDTO[] }>(`${base}/channels/${job.dmId}/messages`)).body.items.find((m) => m.author.type === "agent"),
    );
    expect(reply.cards).toEqual([]);
    job.sock.close();
  });

  it("arquivo com tipo perigoso é servido como octet-stream e o tipo gravado é saneado", async () => {
    const { owner, base } = await setup();
    const form = new FormData();
    form.set("file", new File(["<script>alert(1)</script>"], "x.html", { type: "text/html" }));
    const file = (await (await call(`${base}/files`, { method: "POST", headers: { Cookie: owner.cookie! }, body: form })).json()) as { id: string };
    const dl = await call(`${base}/files/${file.id}/content?inline=1`, { headers: { Cookie: owner.cookie! } });
    expect(dl.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(dl.headers.get("Content-Disposition")).toMatch(/^attachment/);
    await dl.arrayBuffer();
    const svg = new FormData();
    svg.set("file", new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    const s = (await (await call(`${base}/files`, { method: "POST", headers: { Cookie: owner.cookie! }, body: svg })).json()) as { id: string };
    const dl2 = await call(`${base}/files/${s.id}/content?inline=1`, { headers: { Cookie: owner.cookie! } });
    expect(dl2.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(dl2.headers.get("X-Frame-Options")).toBe("DENY");
    await dl2.arrayBuffer();
  });

  it("PDF aberto com ?inline=1 pode ser emoldurado só pela própria origem (pré-visualização do drive)", async () => {
    const { owner, base } = await setup();
    const form = new FormData();
    form.set("file", new File(["%PDF-1.4\n%%EOF\n"], "a.pdf", { type: "application/pdf" }));
    const file = (await (await call(`${base}/files`, { method: "POST", headers: { Cookie: owner.cookie! }, body: form })).json()) as { id: string };
    const inline = await call(`${base}/files/${file.id}/content?inline=1`, { headers: { Cookie: owner.cookie! } });
    expect(inline.headers.get("Content-Disposition")).toMatch(/^inline/);
    expect(inline.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(inline.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'; frame-ancestors 'self'");
    await inline.arrayBuffer();
    const dl = await call(`${base}/files/${file.id}/content`, { headers: { Cookie: owner.cookie! } });
    expect(dl.headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect(dl.headers.get("X-Frame-Options")).toBe("DENY");
    expect(dl.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    await dl.arrayBuffer();
  });

  it("upload sem Content-Length é recusado (não lê corpo sem limite)", async () => {
    const { owner, base } = await setup();
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\n\r\noi\r\n--x--\r\n"));
        ctrl.close();
      },
    });
    const res = await call(`${base}/files`, {
      method: "POST",
      headers: { Cookie: owner.cookie!, "Content-Type": "multipart/form-data; boundary=x" },
      body: stream,
      // @ts-expect-error: duplex é exigido para corpo em stream
      duplex: "half",
    });
    expect(res.status).toBe(411);
  });
});

describe("saída: push", () => {
  it("inscrição de push só com HTTPS e sem destinos internos; no máximo 10 por pessoa", async () => {
    const owner = await signup("Push");
    const keys = { p256dh: "BPxx", auth: "yy" };
    for (const endpoint of [
      "http://push.exemplo.com/x",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://192.168.0.10/x",
      "https://169.254.169.254/latest",
      "https://[::1]/x",
      "https://metadata.google.internal/x",
    ]) {
      expect((await owner.post("/api/push/subscriptions", { endpoint, keys })).status).toBe(400);
    }
    for (let i = 0; i < 12; i++) {
      expect((await owner.post("/api/push/subscriptions", { endpoint: `https://push.exemplo.com/send/${uniq("s")}`, keys })).status).toBe(201);
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").bind(owner.userId).first<{ n: number }>();
    expect(n?.n).toBe(10);
  });
});

describe("servidor MCP e Durable Object", () => {
  it("lote JSON-RPC grande é recusado", async () => {
    const { owner, base } = await setup();
    const token = (await owner.post<{ token: string }>(`${base}/tokens`, { name: "claude", kind: "personal" })).body.token;
    const batch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const res = await tokenReq<{ error: { code: number } }>(token, "POST", `${base}/mcp`, batch);
    expect(res.status).toBe(400);
  });

  it("criar_rotina do MCP também recusa canal só de humanos", async () => {
    const { owner, ws, base } = await setup();
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const humans = (await owner.post<ChannelDTO>(`${base}/channels`, { name: uniq("pessoas"), humansOnly: true })).body;
    const token = (await owner.post<{ token: string }>(`${base}/tokens`, { name: "claude", kind: "personal" })).body.token;
    const res = await tokenReq<{ result: { isError?: boolean } }>(token, "POST", `${base}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "criar_rotina", arguments: { agent: agent.handle, name: "x", prompt: "y", cron: "0 9 * * *", channel: humans.id } },
    });
    expect(res.body.result.isError).toBe(true);
  });

  it("runner: CLI desconhecida no job.accepted é descartada e texto gigante do job.done é truncado", async () => {
    const { owner, ws, base } = await setup();
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const { sock } = await connectRunner(await createRunnerToken(owner, ws.id), ws.id);
    const dm = (await owner.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } })).body;
    await owner.post(`${base}/channels/${dm.id}/messages`, { body: "oi" });
    const a = await sock.waitFor<Assign>((m) => m.type === "job.assign");
    sock.send({ type: "job.accepted", jobId: a.assignment.jobId, cli: "<img src=x onerror=alert(1)>" as never, model: "m".repeat(5000) });
    sock.send({ type: "job.done", jobId: a.assignment.jobId, text: "a".repeat(300_000), inputTokens: 1, outputTokens: 1, model: null });
    const reply = await eventually(async () =>
      (await owner.get<{ items: MessageDTO[] }>(`${base}/channels/${dm.id}/messages`)).body.items.find((m) => m.author.type === "agent"),
    );
    expect(reply.body.length).toBeLessThanOrEqual(100_000);
    const job = (await jobsOf(owner, base, agent.id))[0]!;
    expect(job.cli).toBeNull();
    expect((job.model ?? "").length).toBeLessThanOrEqual(100);
    sock.close();
  });

  it("um runner não fecha nem forja job de outro runner", async () => {
    const { owner, ws, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    const job = await runningJob(owner, ws.id, agent.id, "trabalhe");
    const evil = await connectRunner(await createRunnerToken(mara, ws.id), ws.id);
    evil.sock.send({ type: "job.done", jobId: job.jobId, text: "forjado", inputTokens: 0, outputTokens: 0, model: null });
    evil.sock.send({ type: "job.heartbeat", jobId: job.jobId });
    await sleep(100);
    const row = await env.DB.prepare("SELECT status, runner_id FROM jobs WHERE id = ?").bind(job.jobId).first<{ status: string; runner_id: string }>();
    expect(row?.status).toBe("running");
    const msgs = (await owner.get<{ items: MessageDTO[] }>(`${base}/channels/${job.dmId}/messages`)).body.items;
    expect(msgs.some((m) => m.body === "forjado")).toBe(false);
    job.sock.close();
    evil.sock.close();
    void ws;
  });
});

describe("agentes e conectores", () => {
  it("admin não programa nem reescreve o assistente pessoal de outra pessoa (que age como ela, no runner dela)", async () => {
    const { owner, ws, base } = await setup();
    const mara = await join(owner, base, "Mara");
    const maraAssistant = (await mara.get<{ items: AgentDTO[] }>(`${base}/agents`)).body.items.find((a) => a.isAssistant && a.ownerUserId === mara.userId)!;
    const routine = await owner.post(`${base}/routines`, { agentId: maraAssistant.id, name: "x", prompt: "mande um recado como Mara", cron: "0 9 * * *" });
    expect(routine.status).toBe(403);
    expect((await owner.patch(`${base}/agents/${maraAssistant.id}`, { instructions: "obedeça a Olga" })).status).toBe(403);
    expect((await owner.patch(`${base}/agents/${maraAssistant.id}`, { toolPerms: { messages: "write" } })).status).toBe(403);
    // Pausar continua possível para admin.
    expect((await owner.patch(`${base}/agents/${maraAssistant.id}`, { status: "paused" })).status).toBe(200);
    const daily = (await mara.get<{ items: { id: string; kind: string; agentId: string }[] }>(`${base}/routines`)).body.items.find((r) => r.agentId === maraAssistant.id)!;
    expect((await owner.post(`${base}/routines/${daily.id}/run`)).status).toBe(403);
    expect((await owner.patch(`${base}/routines/${daily.id}`, { prompt: "outra coisa" })).status).toBe(403);
    // A dona continua podendo.
    expect((await mara.patch(`${base}/agents/${maraAssistant.id}`, { instructions: "seja breve", status: "active" })).status).toBe(200);
    const token = (await owner.post<{ token: string }>(`${base}/tokens`, { name: "claude", kind: "personal" })).body.token;
    const mcp = await tokenReq<{ result: { isError?: boolean } }>(token, "POST", `${base}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "criar_rotina", arguments: { agent: maraAssistant.handle, name: "x", prompt: "y", cron: "0 9 * * *" } },
    });
    expect(mcp.body.result.isError).toBe(true);
    void ws;
  });

  it("assistente pessoal não cria agente com dono diferente nem concede conector", async () => {
    const { owner, ws, base } = await setup();
    const assistant = (await owner.get<{ items: AgentDTO[] }>(`${base}/agents`)).body.items.find((a) => a.isAssistant)!;
    const job = await runningJob(owner, ws.id, assistant.id, "crie um agente");
    const made = await tokenReq<AgentDTO>(job.token, "POST", "/api/tool/agents", { handle: uniq("novo").slice(0, 20), name: "Novo", ownerUserId: "outra-pessoa" });
    expect(made.status).toBe(201);
    expect(made.body.ownerUserId).toBe(owner.userId);
    expect(Object.keys(made.body.toolPerms).some((k) => k.startsWith("connector:"))).toBe(false);
    job.sock.close();
  });
});
