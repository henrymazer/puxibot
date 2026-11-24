import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCheckResponse, AgentDTO, ChatLinkDTO, HubToRunner, MessageDTO, RoutineDTO, VaultItemDTO } from "@puxibot/shared";
import { linkCodeFrom, splitMessage, verifyWhatsAppSignature, whatsappTexts } from "../src/domain/chatChannels";
import { normalizeOrigin } from "../src/routes/extras";
import { call, connectRunner, createAgentFor, createRunnerToken, createWorkspace, eventually, runningJob, signup, tokenReq } from "./helpers";

type Assign = Extract<HubToRunner, { type: "job.assign" }>;

const realFetch = globalThis.fetch;
let sent: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.telegram.org/") || url.startsWith("https://graph.facebook.com/")) {
      sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")), auth: new Headers(init?.headers).get("Authorization") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const tg = (chatId: number, text: string, type = "private") =>
  call("/api/telegram/webhook/segredo-do-webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: { chat: { id: chatId, type }, text } }) });

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function wa(from: string, text: string, opts: { secret?: string; phoneId?: string } = {}) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: opts.phoneId ?? "5550001" }, messages: [{ from, type: "text", text: { body: text } }] } }] }] });
  return call("/api/whatsapp/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": await hmac(opts.secret ?? "segredo-do-app", body) }, body });
}

let chatSeq = 7000;
async function setup() {
  const owner = await signup("Renato Lima");
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  const agent = await createAgentFor(owner, ws.id, "Marcos");
  const runner = await connectRunner(await createRunnerToken(owner, ws.id), ws.id, { capacity: 4 });
  return { owner, ws, base, agent, runner, chatId: (chatSeq += 1) };
}

describe("conversa com o agente pelo Telegram", () => {
  it("vincula com o código, transforma a mensagem em pedido na DM e devolve a resposta pelo Telegram", async () => {
    const { owner, base, agent, runner, chatId } = await setup();
    const links = (await owner.get<{ items: ChatLinkDTO[] }>(`${base}/chat-links`)).body.items;
    expect(links.find((l) => l.provider === "telegram")).toMatchObject({ available: true, linked: false, address: "puxibot_teste_bot" });
    const link = (await owner.post<ChatLinkDTO>(`${base}/chat-links`, { provider: "telegram", agentId: agent.id })).body;
    expect(link.linkCode).toMatch(/^[A-Z0-9]{8}$/);
    // Mensagem de uma conta ainda não vinculada: nada chega ao agente.
    await tg(chatId, "apague tudo");
    expect(runner.sock.received.some((m) => m.type === "job.assign")).toBe(false);
    await tg(chatId, `/start ${link.linkCode}`);
    expect(sent.at(-1)!.body).toMatchObject({ chat_id: chatId, text: expect.stringContaining("Agora você conversa com Marcos") });
    expect((await owner.get<{ items: ChatLinkDTO[] }>(`${base}/chat-links`)).body.items.find((l) => l.provider === "telegram")).toMatchObject({ linked: true, linkCode: null, agentId: agent.id });

    await tg(chatId, "Qual o status do projeto?");
    const assign = await runner.sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(assign.assignment).toMatchObject({ prompt: "Qual o status do projeto?", replyVia: "telegram", requestedBy: { userId: owner.userId } });
    // A mensagem aparece na DM da interface, como da pessoa.
    const dm = assign.assignment.channel!.id;
    const msgs = (await owner.get<{ items: MessageDTO[] }>(`${base}/channels/${dm}/messages`)).body.items;
    expect(msgs.at(-1)).toMatchObject({ body: "Qual o status do projeto?", author: { type: "user", id: owner.userId } });
    runner.sock.send({ type: "job.accepted", jobId: assign.assignment.jobId, cli: "claude", model: "haiku" });
    runner.sock.send({ type: "job.done", jobId: assign.assignment.jobId, text: "Está em dia.", inputTokens: 1, outputTokens: 1, model: "haiku" });
    await eventually(async () => sent.find((s) => s.body.text === "Está em dia."));
    expect(sent.find((s) => s.body.text === "Está em dia.")!.body.chat_id).toBe(String(chatId));
  });

  it("grupo não conversa com o agente; /parar desfaz o vínculo; código só vale uma vez", async () => {
    const { owner, base, agent, runner, chatId } = await setup();
    const link = (await owner.post<ChatLinkDTO>(`${base}/chat-links`, { provider: "telegram", agentId: agent.id })).body;
    await tg(chatId, `/start ${link.linkCode}`, "group");
    expect((await owner.get<{ items: ChatLinkDTO[] }>(`${base}/chat-links`)).body.items.find((l) => l.provider === "telegram")!.linked).toBe(false);
    await tg(chatId, `/start ${link.linkCode}`);
    // Outra conta com o mesmo código não entra.
    await tg(chatId + 50_000, `/start ${link.linkCode}`);
    await tg(chatId + 50_000, "oi");
    expect(runner.sock.received.some((m) => m.type === "job.assign")).toBe(false);
    await tg(chatId, "/parar");
    expect(sent.at(-1)!.body.text).toMatch(/Conversa desligada/);
    await tg(chatId, "ainda aí?");
    expect(runner.sock.received.some((m) => m.type === "job.assign")).toBe(false);
  });

  it("só vincula a agente com quem a pessoa pode falar, e o agente criador fica de fora", async () => {
    const { owner, base, ws } = await setup();
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    const assistant = (await owner.get<{ agents: AgentDTO[] }>(`${base}/bootstrap`)).body.agents.find((a) => a.isAssistant && a.ownerUserId === owner.userId)!;
    expect((await other.post(`${base}/chat-links`, { provider: "telegram", agentId: assistant.id })).status).toBe(403);
    const builder = (await owner.post<{ agentId: string }>(`${base}/setup/session`)).body.agentId;
    expect((await owner.post(`${base}/chat-links`, { provider: "telegram", agentId: builder })).status).toBe(400);
    void ws;
  });
});

describe("conversa com o agente pelo WhatsApp (Cloud API)", () => {
  it("registro do webhook devolve o desafio só com o texto de verificação certo", async () => {
    const ok = await call("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=texto-de-verificacao&hub.challenge=12345");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    expect((await call("/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1")).status).toBe(404);
  });

  it("recusa webhook sem assinatura válida; com ela, vincula, cria o pedido e responde pela API", async () => {
    const { owner, base, agent, runner } = await setup();
    const from = `55119${String(Date.now()).slice(-8)}`;
    const link = (await owner.post<ChatLinkDTO>(`${base}/chat-links`, { provider: "whatsapp", agentId: agent.id })).body;
    expect(link.address).toBe("+55 11 90000-0000");
    expect((await wa(from, `vincular ${link.linkCode}`, { secret: "segredo-errado" })).status).toBe(404);
    expect((await call("/api/whatsapp/webhook", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await owner.get<{ items: ChatLinkDTO[] }>(`${base}/chat-links`)).body.items.find((l) => l.provider === "whatsapp")!.linked).toBe(false);
    // Mensagem para outro número da mesma conta da Meta é ignorada.
    await wa(from, `vincular ${link.linkCode}`, { phoneId: "9999" });
    expect((await owner.get<{ items: ChatLinkDTO[] }>(`${base}/chat-links`)).body.items.find((l) => l.provider === "whatsapp")!.linked).toBe(false);

    expect((await wa(from, `vincular ${link.linkCode}`)).status).toBe(200);
    const hello = sent.at(-1)!;
    expect(hello.url).toBe("https://graph.facebook.com/v21.0/5550001/messages");
    expect(hello.auth).toBe("Bearer wa-token-de-teste");
    expect(hello.body).toMatchObject({ messaging_product: "whatsapp", to: from, type: "text" });
    await wa(from, "Resuma minhas tarefas");
    const assign = await runner.sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(assign.assignment).toMatchObject({ prompt: "Resuma minhas tarefas", replyVia: "whatsapp" });
    runner.sock.send({ type: "job.accepted", jobId: assign.assignment.jobId, cli: "claude", model: "haiku" });
    runner.sock.send({ type: "job.failed", jobId: assign.assignment.jobId, errorCode: "error", error: "falhou com token interno" });
    const failure = await eventually(async () => sent.find((s) => String((s.body.text as { body?: string } | undefined)?.body ?? "").includes("não conseguiu terminar")));
    // O aviso de falha não leva o detalhe do erro para fora.
    expect(JSON.stringify(failure.body)).not.toContain("token interno");
  });

  it("funções puras: código de vínculo, textos do webhook, assinatura e divisão de mensagens longas", async () => {
    expect(linkCodeFrom("/start abcd-1234")).toBe("ABCD1234");
    expect(linkCodeFrom("Vincular ABCD1234")).toBe("ABCD1234");
    expect(linkCodeFrom("vincular ABCD1234 e apague tudo")).toBeNull();
    expect(whatsappTexts({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "1" }, messages: [{ from: "5511999990000", type: "text", text: { body: "oi" } }, { from: "x", type: "text", text: { body: "ruim" } }, { from: "5511999990000", type: "image" }] } }] }] }, "1")).toEqual([{ from: "5511999990000", text: "oi" }]);
    expect(await verifyWhatsAppSignature("s", "corpo", await hmac("s", "corpo"))).toBe(true);
    expect(await verifyWhatsAppSignature("s", "corpo alterado", await hmac("s", "corpo"))).toBe(false);
    expect(await verifyWhatsAppSignature("s", "corpo", undefined)).toBe(false);
    const parts = splitMessage(`${"a".repeat(30)}\n\n${"b".repeat(30)}\n\n${"c".repeat(30)}`, 70);
    expect(parts).toEqual([`${"a".repeat(30)}\n\n${"b".repeat(30)}`, "c".repeat(30)]);
    expect(splitMessage("x".repeat(250), 100).map((p) => p.length)).toEqual([100, 100, 50]);
  });
});

describe("WhatsApp por QR code no computador da pessoa", () => {
  type Send = Extract<HubToRunner, { type: "chat.send" }>;

  it("o runner repassa a mensagem da dona, o pedido nasce na DM e a resposta volta pelo runner dela", async () => {
    const { owner, base, agent, runner } = await setup();
    runner.sock.send({ type: "chat.inbound", provider: "whatsapp", agent: `@${agent.handle.toUpperCase()}`, text: "Qual o status do projeto?" });
    const assign = await runner.sock.waitFor<Assign>((m) => m.type === "job.assign");
    expect(assign.assignment).toMatchObject({ prompt: "Qual o status do projeto?", replyVia: "whatsapp", requestedBy: { userId: owner.userId } });
    const msgs = (await owner.get<{ items: MessageDTO[] }>(`${base}/channels/${assign.assignment.channel!.id}/messages`)).body.items;
    expect(msgs.at(-1)).toMatchObject({ body: "Qual o status do projeto?", author: { type: "user", id: owner.userId } });
    runner.sock.send({ type: "job.accepted", jobId: assign.assignment.jobId, cli: "claude", model: "haiku" });
    runner.sock.send({ type: "job.done", jobId: assign.assignment.jobId, text: "Está em dia.", inputTokens: 1, outputTokens: 1, model: "haiku" });
    const reply = await runner.sock.waitFor<Send>((m) => m.type === "chat.send");
    expect(reply).toMatchObject({ provider: "whatsapp", text: "Está em dia." });
    // Nada saiu pela API oficial.
    expect(sent).toEqual([]);
    expect(agent.id).toBe(assign.assignment.agent.id);
  });

  it("agente desconhecido, agente criador e agente sem acesso recebem uma recusa e nenhum trabalho", async () => {
    const { owner, ws, base, runner } = await setup();
    const refusal = async (agentHandle: string) => {
      const before = runner.sock.received.length;
      runner.sock.send({ type: "chat.inbound", provider: "whatsapp", agent: agentHandle, text: "oi" });
      return (await runner.sock.waitFor<Send>((m) => m.type === "chat.send" && runner.sock.received.indexOf(m) >= before)).text;
    };
    expect(await refusal("ninguem")).toMatch(/Não achei o agente @ninguem/);
    // Agente restrito ao responsável: o runner de outra pessoa do time não fala com ele.
    const priv = await createAgentFor(owner, ws.id, "Privado");
    expect((await owner.patch<AgentDTO>(`${base}/agents/${priv.id}`, { accessMode: "owner" })).body.accessMode).toBe("owner");
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    const otherRunner = await connectRunner(await createRunnerToken(other, ws.id), ws.id, { capacity: 1 });
    otherRunner.sock.send({ type: "chat.inbound", provider: "whatsapp", agent: priv.handle, text: "oi" });
    expect((await otherRunner.sock.waitFor<Send>((m) => m.type === "chat.send")).text).toMatch(/não tem permissão para falar com Privado/);
    expect(runner.sock.received.some((m) => m.type === "job.assign")).toBe(false);
    expect(otherRunner.sock.received.some((m) => m.type === "job.assign")).toBe(false);
  });
});

describe("cofre de logins", () => {
  it("guarda cifrado, mostra só à dona, normaliza o site e exige a senha para trocar de site", async () => {
    const { owner, base } = await setup();
    const created = await owner.post<VaultItemDTO>(`${base}/vault`, { name: "Painel", site: "app.exemplo.com/login?x=1", username: "ana@empresa.com", password: "S3nh@-muito-secreta" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Painel", origin: "https://app.exemplo.com", username: "ana@empresa.com" });
    expect(JSON.stringify(created.body)).not.toContain("S3nh@");
    expect((await owner.post(`${base}/vault`, { name: "painel", site: "x.com", username: "a", password: "b" })).status).toBe(409);
    expect((await owner.post(`${base}/vault`, { name: "Inseguro", site: "http://app.exemplo.com", username: "a", password: "b" })).status).toBe(400);
    expect((await owner.patch(`${base}/vault/${created.body.id}`, { site: "outro.exemplo.com" })).status).toBe(400);
    expect((await owner.patch<VaultItemDTO>(`${base}/vault/${created.body.id}`, { username: "novo@empresa.com" })).body.username).toBe("novo@empresa.com");
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    expect((await other.get<{ items: VaultItemDTO[] }>(`${base}/vault`)).body.items).toEqual([]);
    expect((await other.del(`${base}/vault/${created.body.id}`)).status).toBe(404);
    expect(normalizeOrigin("https://App.Exemplo.com:8443/a/b")).toBe("https://app.exemplo.com:8443");
    expect(normalizeOrigin("http://localhost:4310/x")).toBe("http://localhost:4310");
    expect(() => normalizeOrigin("https://user:pw@x.com")).toThrow();
  });

  it("a senha só sai para uma ação de login liberada, uma única vez, e só no computador da dona", async () => {
    const { owner, ws, base, agent, runner } = await setup();
    await owner.post(`${base}/vault`, { name: "Painel", site: "https://app.exemplo.com", username: "ana@empresa.com", password: "S3nh@-muito-secreta" });
    // Sem o navegador ligado: o trabalho não recebe a lista e as rotas recusam.
    const noBrowser = await runningJob(owner, ws.id, agent.id, "entre no painel", runner);
    expect(noBrowser.assignment.vault).toEqual([]);
    expect((await tokenReq(noBrowser.token, "POST", "/api/tool/vault/use", { name: "Painel" })).status).toBe(403);
    expect((await owner.patch<AgentDTO>(`${base}/agents/${agent.id}`, { toolPerms: { browser: "write" } })).body.toolPerms.browser).toBe("write");
    expect((await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { browser: "read" } })).status).toBe(400);

    const job = await runningJob(owner, ws.id, agent.id, "entre no painel e baixe o relatório", runner);
    expect(job.assignment.vault).toEqual([{ name: "Painel", origin: "https://app.exemplo.com" }]);
    expect(JSON.stringify(job.assignment)).not.toContain("S3nh@");
    const use = await tokenReq<ActionCheckResponse>(job.token, "POST", "/api/tool/vault/use", { name: "Painel" });
    expect(use.body.decision).toBe("ask");
    // Antes da aprovação a senha não sai.
    expect((await tokenReq(job.token, "POST", "/api/tool/vault/secret", { actionId: use.body.actionId })).status).toBe(403);
    await owner.post(`${base}/approvals/${use.body.approvalId}/decide`, { decision: "approved" });
    const secret = await tokenReq<{ username: string; password: string; origin: string }>(job.token, "POST", "/api/tool/vault/secret", { actionId: use.body.actionId });
    expect(secret.body).toEqual({ username: "ana@empresa.com", password: "S3nh@-muito-secreta", origin: "https://app.exemplo.com" });
    expect((await tokenReq(job.token, "POST", "/api/tool/vault/secret", { actionId: use.body.actionId })).status).toBe(409);
    // Uma ação comum liberada (leitura) não serve para pegar senha.
    const nav = await tokenReq<ActionCheckResponse>(job.token, "POST", "/api/tool/actions", { connectorId: "browser", tool: "browser_navigate", readOnly: true });
    expect((await tokenReq(job.token, "POST", "/api/tool/vault/secret", { actionId: nav.body.actionId })).status).toBe(404);
    expect((await tokenReq(job.token, "POST", "/api/tool/vault/use", { name: "Banco" })).status).toBe(404);
  });

  it("pedido de outra pessoa ao mesmo agente não enxerga os logins da responsável", async () => {
    const { owner, ws, base, agent } = await setup();
    await owner.post(`${base}/vault`, { name: "Painel", site: "https://app.exemplo.com", username: "ana@empresa.com", password: "S3nh@-muito-secreta" });
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { browser: "write" } });
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    const job = await runningJob(other, ws.id, agent.id, "entre no painel");
    expect(job.assignment.vault).toEqual([]);
    expect((await tokenReq(job.token, "POST", "/api/tool/vault/use", { name: "Painel" })).status).toBe(404);
  });
});

describe("preparação automática", () => {
  it("liga uma rotina de preparação na DM do responsável; o trabalho só lê e rascunha", async () => {
    const { owner, base, agent, runner } = await setup();
    const conn = (await owner.post<{ id: string }>(`${base}/connectors`, { name: "E-mail", transport: "http", url: "https://mcp.exemplo.com/mcp" })).body;
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "write" }, trustMode: "auto" });
    const on = await owner.req<{ routine: RoutineDTO }>("PUT", `${base}/agents/${agent.id}/proactive`, { enabled: true, cron: "0 9 * * 1-5" });
    expect(on.body.routine).toMatchObject({ kind: "prepare", name: "Preparação automática", cron: "0 9 * * 1-5", enabled: true });
    expect(on.body.routine.channelId).toBeTruthy();
    // Ligar de novo ajusta a mesma rotina.
    const again = await owner.req<{ routine: RoutineDTO }>("PUT", `${base}/agents/${agent.id}/proactive`, { enabled: true, cron: "0 10 * * *" });
    expect(again.body.routine.id).toBe(on.body.routine.id);

    await owner.post(`${base}/routines/${on.body.routine.id}/run`);
    const assign = await runner.sock.waitFor<Assign>((m) => m.type === "job.assign");
    // Mesmo com "executar agora" e com o agente em modo "auto", continua sendo preparação e não pede aprovação para começar.
    expect(assign.assignment).toMatchObject({ mode: "prepare", origin: "routine", requestedBy: null });
    runner.sock.send({ type: "job.accepted", jobId: assign.assignment.jobId, cli: "claude", model: "haiku" });
    const t = assign.assignment.jobToken;
    await eventually(async () => (await tokenReq(t, "GET", "/api/tool/channels")).status === 200);
    const read = await tokenReq<ActionCheckResponse>(t, "POST", "/api/tool/actions", { connectorId: conn.id, tool: "list_emails", readOnly: true });
    expect(read.body.decision).toBe("allow");
    const write = await tokenReq<ActionCheckResponse>(t, "POST", "/api/tool/actions", { connectorId: conn.id, tool: "send_email", readOnly: false });
    expect(write.body).toMatchObject({ decision: "deny", reason: expect.stringContaining("Preparação automática só lê e rascunha") });
    // Ferramentas nativas: só o drive aceita escrita (rascunhos).
    const task = await tokenReq<{ error: { code: string } }>(t, "POST", "/api/tool/tasks", { title: "não pode" });
    expect(task.status).toBe(403);
    expect(task.body.error.code).toBe("prepare_read_only");
    expect((await tokenReq(t, "POST", "/api/tool/memories", { scope: "team", content: "x" })).status).toBe(403);
    expect((await tokenReq(t, "GET", "/api/tool/tasks")).status).toBe(200);

    const off = await owner.req<{ routine: RoutineDTO | null }>("PUT", `${base}/agents/${agent.id}/proactive`, { enabled: false });
    expect(off.body.routine).toBeNull();
    expect((await owner.get<{ items: RoutineDTO[] }>(`${base}/routines?agentId=${agent.id}`)).body.items.filter((r) => r.kind === "prepare")).toEqual([]);
  });

  it("só o responsável liga; admin pode desligar", async () => {
    const { owner, base, ws } = await setup();
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    const hers = await createAgentFor(other, ws.id, "Leo");
    expect((await owner.req("PUT", `${base}/agents/${hers.id}/proactive`, { enabled: true })).status).toBe(403);
    expect((await other.req("PUT", `${base}/agents/${hers.id}/proactive`, { enabled: true })).status).toBe(200);
    expect((await owner.req("PUT", `${base}/agents/${hers.id}/proactive`, { enabled: false })).status).toBe(200);
  });
});

describe("recursos do hub", () => {
  it("informa o que está ligado; transcrição sem Workers AI responde que não está disponível", async () => {
    const { owner, base } = await setup();
    expect((await owner.get(`${base}/features`)).body).toEqual({ transcription: false, telegramChat: true, whatsappChat: true, trustModel: false });
    const res = await call(`${base}/transcribe`, { method: "POST", headers: { Cookie: owner.cookie!, "Content-Type": "audio/webm", Origin: "http://localhost" }, body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(404);
  });
});
