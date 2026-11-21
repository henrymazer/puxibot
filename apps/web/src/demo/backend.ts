/**
 * Modo demonstração (só em desenvolvimento): um hub falso em memória.
 * Implementa as rotas do contrato como um `fetch` falso e um WebSocket falso,
 * para que a interface rode com o mesmo ApiClient e o mesmo tratamento de eventos.
 */
import {
  extractMentions,
  userHandle,
  type ActorRef,
  type AgentDTO,
  type ApiTokenDTO,
  type ApprovalDTO,
  type ChannelDTO,
  type ClientEvent,
  type FileDTO,
  type JobDTO,
  type JobEventDTO,
  type MemberDTO,
  type MemoryDTO,
  type MessageDTO,
  type NotificationDTO,
  type RunnerDTO,
  type SectorDTO,
  type UserDTO,
  type WorkspaceDTO,
} from "@puxibot/shared";
import type { SocketLike } from "../realtime/connection";
import { seed } from "./seed";
import { seedAreas, type AreaDb } from "./seedAreas";
import { registerAreaRoutes } from "./areas";

export interface DemoDb {
  user: UserDTO;
  loggedIn: boolean;
  workspaces: WorkspaceDTO[];
  members: MemberDTO[];
  sectors: SectorDTO[];
  agents: AgentDTO[];
  channels: ChannelDTO[];
  messages: MessageDTO[];
  runners: RunnerDTO[];
  approvals: ApprovalDTO[];
  notifications: NotificationDTO[];
  jobs: (JobDTO & { events: JobEventDTO[] })[];
  memories: MemoryDTO[];
  tokens: ApiTokenDTO[];
  files: FileDTO[];
}

export type FullDemoDb = DemoDb & AreaDb;

export type DemoHandler = (p: { m: RegExpMatchArray; body: any; query: URLSearchParams }) => unknown | Promise<unknown>;

/** O que cada módulo de área (demo/areas/*.ts) recebe para registrar rotas. */
export interface DemoContext {
  db: FullDemoDb;
  /** Registra rota. `:param` vira grupo de captura em `m` (m[1] é o workspace). */
  on: (method: string, pattern: string, h: DemoHandler, status?: number) => void;
  emit: (event: ClientEvent) => void;
  id: (prefix: string) => string;
  sleep: (ms: number) => Promise<void>;
  me: () => MemberDTO;
  requireAdmin: () => void;
  notify: (kind: NotificationDTO["kind"], title: string, body: string | null, link: string | null) => void;
  postMessage: (m: Omit<MessageDTO, "id" | "createdAt" | "replyCount" | "reactions" | "pinned" | "editedAt" | "deleted"> & Partial<MessageDTO>) => MessageDTO;
  /** Simula um agente trabalhando a partir de um pedido (mensagem real ou sintética). */
  runJob: (agent: AgentDTO, trigger: MessageDTO, extra?: Partial<JobDTO>) => Promise<void>;
  /** Guarda o conteúdo de um arquivo para `fileUrl`. */
  setBlob: (fileId: string, url: string) => void;
  W: string;
}

let seq = 1000;
const id = (p: string) => `${p}_${(seq++).toString(36)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createDemoBackend() {
  const base = seed();
  const db: FullDemoDb = { ...base, ...seedAreas(base) };
  const sockets = new Set<FakeSocket>();
  const blobs = new Map<string, string>();

  const emit = (event: ClientEvent) => {
    for (const s of sockets) s.deliver(event);
  };
  const me = () => db.members.find((m) => m.userId === db.user.id)!;
  const ws0 = () => db.workspaces[0]!;

  function json(status: number, body?: unknown): Response {
    if (status === 204 || body === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function findAgent(aid: string): AgentDTO {
    const a = db.agents.find((x) => x.id === aid);
    if (!a) throw new HttpError(404, "not_found", "Agente não encontrado.");
    return a;
  }
  function findMessage(mid: string): MessageDTO {
    const m = db.messages.find((x) => x.id === mid);
    if (!m) throw new HttpError(404, "not_found", "Mensagem não encontrada.");
    return m;
  }
  function findChannel(cid: string): ChannelDTO {
    const c = db.channels.find((x) => x.id === cid);
    if (!c) throw new HttpError(404, "not_found", "Canal não encontrado.");
    return c;
  }
  function requireAdmin() {
    if (me().role === "member") throw new HttpError(403, "forbidden", "Só admins podem fazer isso.");
  }

  function setAgentActivity(agent: AgentDTO, activity: AgentDTO["activity"]) {
    agent.activity = activity;
    emit({ type: "agent.upserted", agent: { ...agent } });
  }

  function postMessage(m: Omit<MessageDTO, "id" | "createdAt" | "replyCount" | "reactions" | "pinned" | "editedAt" | "deleted"> & Partial<MessageDTO>) {
    const msg: MessageDTO = {
      id: id("msg"),
      createdAt: Date.now(),
      replyCount: 0,
      reactions: [],
      pinned: false,
      editedAt: null,
      deleted: false,
      ...m,
    };
    db.messages.push(msg);
    if (msg.threadRootId) {
      const root = db.messages.find((x) => x.id === msg.threadRootId);
      if (root) root.replyCount++;
    }
    const ch = db.channels.find((c) => c.id === msg.channelId);
    if (ch) ch.lastMessageAt = msg.createdAt;
    emit({ type: "message.created", message: msg });
    return msg;
  }

  function systemMessage(channelId: string, body: string, threadRootId: string | null = null) {
    return postMessage({
      channelId,
      author: { type: "system", id: null },
      body,
      threadRootId,
      quote: null,
      attachments: [],
      cards: [],
      mentions: [],
      jobId: null,
      meta: null,
    });
  }

  function updateJob(job: JobDTO & { events: JobEventDTO[] }, patch: Partial<JobDTO>) {
    Object.assign(job, patch);
    const { events: _e, ...dto } = job;
    emit({ type: "job.updated", job: { ...dto } });
  }
  function jobEvent(job: JobDTO & { events: JobEventDTO[] }, kind: JobEventDTO["kind"], summary: string) {
    const ev: JobEventDTO = { id: seq++, jobId: job.id, kind, summary, createdAt: Date.now() };
    job.events.push(ev);
    emit({ type: "job.event", event: ev });
  }

  /** Simula um agente respondendo: fila → execução → streaming → mensagem final. */
  async function runJob(agent: AgentDTO, trigger: MessageDTO, extra: Partial<JobDTO> = {}) {
    const runner = db.runners.find((r) => r.online && r.userId === db.user.id) ?? db.runners.find((r) => r.online);
    const job: JobDTO & { events: JobEventDTO[] } = {
      id: id("job"),
      agentId: agent.id,
      channelId: trigger.channelId,
      threadRootId: trigger.threadRootId,
      triggerMessageId: trigger.id,
      origin: "user",
      requestedByUserId: db.user.id,
      parentJobId: null,
      routineId: null,
      prompt: trigger.body,
      status: "queued",
      runnerId: null,
      runnerUserId: null,
      cli: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      error: null,
      errorCode: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      waitingForRunner: false,
      events: [],
      ...extra,
    };
    db.jobs.unshift(job);
    updateJob(job, {});
    const cancelled = () => (job.status as JobDTO["status"]) === "cancelled";
    const lower = trigger.body.toLowerCase();

    if (lower.includes("aprova")) {
      updateJob(job, { status: "awaiting_approval" });
      setAgentActivity(agent, "waiting_approval");
      const approval: ApprovalDTO = {
        id: id("apr"),
        agentId: agent.id,
        jobId: job.id,
        kind: "action",
        title: `${agent.name} quer publicar uma mudança`,
        details: `Pedido em resposta a: "${trigger.body.slice(0, 120)}"`,
        approverUserId: db.user.id,
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: Date.now(),
      };
      db.approvals.unshift(approval);
      emit({ type: "approval.upserted", approval });
      notify("approval", `${agent.name} pediu sua aprovação`, approval.title, `/aprovacoes`);
      return;
    }
    if (!runner || lower.includes("sem computador")) {
      updateJob(job, { waitingForRunner: true });
      setAgentActivity(agent, "queued_no_runner");
      return;
    }
    await sleep(700);
    if (cancelled()) return;
    const cli = agent.preferredCli ?? runner.clis[0]?.cli ?? "claude";
    const model = agent.preferredModel ?? (cli === "claude" ? "Opus 5.5" : cli === "codex" ? "GPT-5.3" : "Gemini 3 Pro");
    updateJob(job, { status: "running", runnerId: runner.id, runnerUserId: runner.userId, cli, model, startedAt: Date.now() });
    setAgentActivity(agent, "working");
    jobEvent(job, "status", `Começou no computador ${runner.name}`);
    if (lower.includes("erro")) {
      await sleep(1200);
      updateJob(job, { status: "failed", error: "A CLI recusou a chave de acesso.", errorCode: "auth", finishedAt: Date.now() });
      setAgentActivity(agent, "error");
      systemMessage(trigger.channelId, `${agent.name} parou com um erro: a CLI recusou a chave de acesso.`, trigger.threadRootId);
      return;
    }
    jobEvent(job, "tool", "Consultou a memória do time");
    const answer = replyFor(agent, trigger.body);
    let acc = "";
    const words = answer.split(/(\s+)/);
    for (let i = 0; i < words.length; i++) {
      if (cancelled()) return;
      acc += words[i];
      if (i % 3 === 0 || i === words.length - 1) {
        emit({ type: "job.stream", jobId: job.id, channelId: job.channelId, agentId: agent.id, text: acc });
        await sleep(60);
      }
    }
    await sleep(250);
    if (cancelled()) return;
    const runnerOwner = db.members.find((m) => m.userId === runner.userId);
    const cards = lower.includes("relatório") || lower.includes("relatorio") ? demoCards() : [];
    if (!trigger.channelId) {
      updateJob(job, { status: "done", inputTokens: 1800, outputTokens: answer.length, finishedAt: Date.now() });
      setAgentActivity(agent, "idle");
      return;
    }
    postMessage({
      channelId: trigger.channelId,
      author: { type: "agent", id: agent.id },
      body: answer,
      threadRootId: trigger.threadRootId,
      quote: null,
      attachments: [],
      cards,
      mentions: [],
      jobId: job.id,
      meta: { cli, model, runnerUserId: runner.userId, runnerName: runnerOwner?.name ?? runner.name },
    });
    updateJob(job, { status: "done", inputTokens: 1800, outputTokens: answer.length, finishedAt: Date.now() });
    jobEvent(job, "status", "Terminou e respondeu na conversa");
    setAgentActivity(agent, "idle");
  }

  function notify(kind: NotificationDTO["kind"], title: string, body: string | null, link: string | null) {
    const n: NotificationDTO = { id: id("ntf"), kind, title, body, link, read: false, createdAt: Date.now() };
    db.notifications.unshift(n);
    emit({ type: "notification.created", notification: n });
  }

  function routeToAgents(msg: MessageDTO) {
    const ch = findChannel(msg.channelId);
    if (ch.humansOnly) return;
    const targets: AgentDTO[] = [];
    if (ch.kind === "dm") {
      const a = ch.members.find((m) => m.type === "agent");
      if (a) targets.push(findAgent(a.id));
    } else {
      for (const h of extractMentions(msg.body)) {
        const a = db.agents.find((x) => x.handle === h);
        if (a) targets.push(a);
      }
      if (targets.length === 0 && msg.threadRootId) {
        const root = db.messages.find((m) => m.id === msg.threadRootId);
        if (root?.author.type === "agent" && root.author.id) targets.push(findAgent(root.author.id));
      }
    }
    for (const a of targets) {
      if (a.status === "paused") {
        systemMessage(msg.channelId, `${a.name} está pausado e não vai responder agora.`, msg.threadRootId);
        continue;
      }
      void runJob(a, msg);
    }
  }

  function resolveMentions(body: string): ActorRef[] {
    const out: ActorRef[] = [];
    for (const h of extractMentions(body)) {
      const a = db.agents.find((x) => x.handle === h);
      if (a) out.push({ type: "agent", id: a.id });
      else {
        const m = db.members.find((x) => userHandle(x) === h);
        if (m) out.push({ type: "user", id: m.userId });
      }
    }
    return out;
  }

  const routes: [string, RegExp, DemoHandler, number?][] = [];
  const on = (method: string, pattern: string, h: DemoHandler, status?: number) => {
    const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, "([^/]+)")}$`);
    routes.push([method, rx, h, status]);
  };
  const W = "/workspaces/:ws";

  // ---------- Auth ----------
  on("POST", "/auth/login", ({ body }) => {
    if (!body.email || !body.password) throw new HttpError(400, "invalid", "Preencha e-mail e senha.");
    if (body.password === "errada") throw new HttpError(401, "invalid_credentials", "E-mail ou senha incorretos.");
    db.loggedIn = true;
    return { user: db.user };
  });
  on("GET", "/auth/signup-status", () => ({ open: true, firstAccount: false }));
  on("POST", "/auth/signup", ({ body }) => {
    if (String(body.password ?? "").length < 8) throw new HttpError(400, "invalid", "A senha precisa ter pelo menos 8 caracteres.");
    db.loggedIn = true;
    db.user = { ...db.user, name: body.name, email: body.email };
    return { user: db.user };
  }, 201);
  on("POST", "/auth/logout", () => {
    db.loggedIn = false;
  });
  on("GET", "/me", () => {
    if (!db.loggedIn) throw new HttpError(401, "unauthorized", "Entre para continuar.");
    return { user: db.user, workspaces: db.workspaces };
  });
  on("PATCH", "/me", ({ body }) => {
    db.user = { ...db.user, ...body };
    const m = me();
    Object.assign(m, { name: db.user.name, avatarColor: db.user.avatarColor });
    return { user: db.user };
  });
  on("GET", "/invites/:code", ({ m }) => ({ workspaceName: m[1] === "expirado" ? ws0().name : ws0().name, valid: m[1] !== "expirado" }));
  on("POST", "/invites/:code/accept", () => ({ workspace: ws0() }));

  // ---------- Workspace ----------
  on("POST", "/workspaces", ({ body }) => {
    const w: WorkspaceDTO = { id: id("ws"), name: body.name, kind: body.kind, business: body.business ?? null, routerEnabled: false, role: "owner" };
    db.workspaces.push(w);
    return { workspace: w };
  }, 201);
  on("GET", `${W}`, () => ({ workspace: ws0() }));
  on("PATCH", `${W}`, ({ body }) => {
    requireAdmin();
    Object.assign(ws0(), body);
    return { workspace: ws0() };
  });
  on("GET", `${W}/bootstrap`, () => ({
    workspace: ws0(),
    me: me(),
    members: db.members,
    sectors: db.sectors,
    agents: db.agents,
    channels: db.channels.filter((c) => !c.isPrivate || c.members.some((x) => x.type === "user" && x.id === db.user.id)),
    runners: db.runners,
    pendingApprovals: db.approvals.filter((a) => a.status === "pending"),
    unreadNotifications: db.notifications.filter((n) => !n.read).length,
  }));
  on("GET", `${W}/members`, () => ({ items: db.members }));
  on("PATCH", `${W}/members/:uid`, ({ m, body }) => {
    const mem = db.members.find((x) => x.userId === m[2]);
    if (!mem) throw new HttpError(404, "not_found", "Pessoa não encontrada.");
    if ((body.role || body.title !== undefined) && mem.userId !== db.user.id) requireAdmin();
    Object.assign(mem, body);
    return { member: mem };
  });
  on("DELETE", `${W}/members/:uid`, ({ m }) => {
    requireAdmin();
    db.members = db.members.filter((x) => x.userId !== m[2]);
  });
  on("POST", `${W}/invites`, () => {
    requireAdmin();
    const code = Math.random().toString(36).slice(2, 10);
    return { code, url: `${location.origin}/convite/${code}` };
  }, 201);
  on("GET", `${W}/sectors`, () => ({ items: db.sectors }));
  on("POST", `${W}/sectors`, ({ body }) => {
    requireAdmin();
    const s: SectorDTO = { id: id("sec"), name: body.name, leadUserId: body.leadUserId ?? null };
    db.sectors.push(s);
    return s;
  }, 201);
  on("PATCH", `${W}/sectors/:id`, ({ m, body }) => {
    requireAdmin();
    const s = db.sectors.find((x) => x.id === m[2]);
    if (!s) throw new HttpError(404, "not_found", "Setor não encontrado.");
    Object.assign(s, body);
    return s;
  });
  on("DELETE", `${W}/sectors/:id`, ({ m }) => {
    requireAdmin();
    db.sectors = db.sectors.filter((x) => x.id !== m[2]);
    for (const a of db.agents) if (a.sectorId === m[2]) a.sectorId = null;
  });
  on("GET", `${W}/search`, ({ query }) => {
    const q = (query.get("q") ?? "").toLowerCase();
    return {
      messages: q ? db.messages.filter((x) => !x.deleted && x.body.toLowerCase().includes(q)).slice(-20).reverse() : [],
      tasks: q ? db.tasks.filter((t) => `#${t.number} ${t.title} ${t.description}`.toLowerCase().includes(q)).slice(0, 20) : [],
      wikiPages: q
        ? db.wikiPages.filter((p) => !p.deleted && !p.isFolder && `${p.title} ${p.body}`.toLowerCase().includes(q)).slice(0, 20).map((p) => ({ ...p, body: "" }))
        : [],
      files: q ? db.files.filter((f) => f.inDrive && f.name.toLowerCase().includes(q)).slice(0, 20) : [],
    };
  });
  on("GET", `${W}/messages/:id`, ({ m }) => findMessage(m[2]!));

  // ---------- Tokens e runners ----------
  on("GET", `${W}/tokens`, () => ({ items: db.tokens }));
  on("POST", `${W}/tokens`, ({ body }) => {
    if (!body.name) throw new HttpError(400, "invalid", "Dê um nome ao token.");
    const t: ApiTokenDTO = { id: id("tok"), name: body.name, kind: body.kind, createdAt: Date.now(), lastUsedAt: null };
    db.tokens.push(t);
    return { token: `tb_${crypto.randomUUID().replace(/-/g, "")}` };
  }, 201);
  on("DELETE", `${W}/tokens/:id`, ({ m }) => {
    db.tokens = db.tokens.filter((t) => t.id !== m[2]);
  });
  on("GET", `${W}/runners`, () => ({ items: db.runners }));
  on("DELETE", `${W}/runners/:id`, ({ m }) => {
    db.runners = db.runners.filter((r) => r.id !== m[2]);
  });
  on("POST", `${W}/runner/pair/approve`, async ({ body }) => {
    await sleep(400);
    const code = String(body.pairCode ?? "").replace(/[\s-]/g, "").toUpperCase();
    if (code.length < 6) throw new HttpError(404, "pair_not_found", "Código não encontrado ou expirado. Rode o pareamento de novo no computador.");
    const r: RunnerDTO = {
      id: id("run"),
      userId: db.user.id,
      name: "notebook-novo",
      platform: "linux",
      clis: [{ cli: "claude", version: "2.4.1", loggedIn: true }],
      isolation: "sandbox",
      online: true,
      lastSeenAt: Date.now(),
    };
    db.runners.push(r);
    emit({ type: "runner.updated", runner: r });
    return { ok: true };
  });

  // ---------- Canais ----------
  on("GET", `${W}/channels`, () => ({ items: db.channels }));
  on("POST", `${W}/channels`, ({ body }) => {
    const name = String(body.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!name) throw new HttpError(400, "invalid", "Dê um nome ao canal.");
    if (db.channels.some((c) => c.name === name)) throw new HttpError(409, "exists", "Já existe um canal com esse nome.");
    const members: ActorRef[] = [{ type: "user", id: db.user.id }, ...(body.members ?? [])];
    const c: ChannelDTO = {
      id: id("ch"),
      kind: "channel",
      name,
      section: body.section || null,
      topic: body.topic || null,
      humansOnly: !!body.humansOnly,
      isPrivate: !!body.isPrivate,
      members: body.humansOnly ? members.filter((x) => x.type === "user") : members,
      unread: 0,
      lastMessageAt: null,
    };
    db.channels.push(c);
    emit({ type: "channel.upserted", channel: c });
    return c;
  }, 201);
  on("PATCH", `${W}/channels/:id`, ({ m, body }) => {
    const c = findChannel(m[2]!);
    Object.assign(c, body);
    emit({ type: "channel.upserted", channel: c });
    return c;
  });
  on("DELETE", `${W}/channels/:id`, ({ m }) => {
    db.channels = db.channels.filter((c) => c.id !== m[2]);
    emit({ type: "channel.deleted", channelId: m[2]! });
  });
  on("POST", `${W}/channels/:id/members`, ({ m, body }) => {
    const c = findChannel(m[2]!);
    if (c.humansOnly && body.member.type === "agent") throw new HttpError(400, "humans_only", "Este canal é só de pessoas. Agentes não entram.");
    if (!c.members.some((x) => x.type === body.member.type && x.id === body.member.id)) c.members.push(body.member);
    emit({ type: "channel.upserted", channel: { ...c } });
  });
  on("DELETE", `${W}/channels/:id/members`, ({ m, body }) => {
    const c = findChannel(m[2]!);
    c.members = c.members.filter((x) => !(x.type === body.member.type && x.id === body.member.id));
    emit({ type: "channel.upserted", channel: { ...c } });
  });
  on("POST", `${W}/dms`, ({ body }) => {
    const w: ActorRef = body.with;
    const existing = db.channels.find(
      (c) =>
        c.kind === "dm" &&
        c.members.some((x) => x.type === w.type && x.id === w.id) &&
        c.members.some((x) => x.type === "user" && x.id === db.user.id) &&
        (w.type !== "user" || w.id !== db.user.id || c.members.length === 1),
    );
    if (existing) return existing;
    if (w.type === "agent") {
      const a = findAgent(w.id);
      if (a.accessMode === "owner" && a.ownerUserId !== db.user.id) throw new HttpError(403, "forbidden", `${a.name} só conversa com o responsável.`);
    }
    const c: ChannelDTO = {
      id: id("dm"),
      kind: "dm",
      name: null,
      section: null,
      topic: null,
      humansOnly: w.type === "user",
      isPrivate: true,
      members: [{ type: "user", id: db.user.id }, w],
      unread: 0,
      lastMessageAt: null,
    };
    db.channels.push(c);
    emit({ type: "channel.upserted", channel: c });
    return c;
  }, 201);
  on("GET", `${W}/channels/:id/messages`, ({ m, query }) => {
    const cid = m[2]!;
    const limit = Math.min(100, Number(query.get("limit") ?? 50));
    const before = query.get("before") ? Number(query.get("before")) : Infinity;
    const root = query.get("threadRootId");
    let list = db.messages.filter((x) => x.channelId === cid && !x.deleted);
    if (query.get("pinned")) list = list.filter((x) => x.pinned);
    else if (root) list = list.filter((x) => x.threadRootId === root);
    else list = list.filter((x) => !x.threadRootId);
    list = list.filter((x) => x.createdAt < before).sort((a, b) => a.createdAt - b.createdAt);
    return { items: list.slice(-limit) };
  });
  on("POST", `${W}/channels/:id/messages`, async ({ m, body }) => {
    await sleep(120);
    const c = findChannel(m[2]!);
    if (!body.body?.trim() && !(body.attachmentIds ?? []).length) throw new HttpError(400, "invalid", "A mensagem está vazia.");
    const attachments = (body.attachmentIds ?? []).map((fid: string) => {
      const f = db.files.find((x) => x.id === fid)!;
      return { fileId: f.id, name: f.name, mime: f.mime, size: f.size };
    });
    const msg = postMessage({
      channelId: c.id,
      author: { type: "user", id: db.user.id },
      body: body.body ?? "",
      threadRootId: body.threadRootId ?? null,
      quote: body.quote ?? null,
      attachments,
      cards: [],
      mentions: resolveMentions(body.body ?? ""),
      jobId: null,
      meta: null,
    });
    setTimeout(() => routeToAgents(msg), 50);
    return msg;
  }, 201);
  on("PATCH", `${W}/messages/:id`, ({ m, body }) => {
    const msg = findMessage(m[2]!);
    if (body.body !== undefined) {
      if (msg.author.id !== db.user.id) throw new HttpError(403, "forbidden", "Só quem escreveu pode editar.");
      msg.body = body.body;
      msg.editedAt = Date.now();
      msg.mentions = resolveMentions(body.body);
    }
    if (body.pinned !== undefined) msg.pinned = !!body.pinned;
    emit({ type: "message.updated", message: { ...msg } });
    return msg;
  });
  on("DELETE", `${W}/messages/:id`, ({ m }) => {
    const msg = findMessage(m[2]!);
    msg.deleted = true;
    emit({ type: "message.deleted", channelId: msg.channelId, messageId: msg.id });
  });
  on("POST", `${W}/messages/:id/reactions`, ({ m, body }) => {
    const msg = findMessage(m[2]!);
    const r = msg.reactions.find((x) => x.emoji === body.emoji);
    if (r) {
      if (!r.userIds.includes(db.user.id)) r.userIds.push(db.user.id);
    } else msg.reactions.push({ emoji: body.emoji, userIds: [db.user.id] });
    emit({ type: "message.updated", message: structuredClone(msg) });
  });
  on("DELETE", `${W}/messages/:id/reactions`, ({ m, body }) => {
    const msg = findMessage(m[2]!);
    msg.reactions = msg.reactions
      .map((r) => (r.emoji === body.emoji ? { ...r, userIds: r.userIds.filter((u) => u !== db.user.id) } : r))
      .filter((r) => r.userIds.length);
    emit({ type: "message.updated", message: structuredClone(msg) });
  });
  on("POST", `${W}/channels/:id/read`, ({ m }) => {
    const c = db.channels.find((x) => x.id === m[2]);
    if (c) c.unread = 0;
  });

  // ---------- Agentes ----------
  on("GET", `${W}/agents`, () => ({ items: db.agents }));
  on("POST", `${W}/agents`, ({ body }) => {
    if (db.agents.some((a) => a.handle === body.handle)) throw new HttpError(409, "handle_taken", "Já existe um agente com esse @.");
    const now = Date.now();
    const a: AgentDTO = {
      id: id("agt"),
      handle: body.handle,
      name: body.name,
      role: body.role ?? null,
      description: body.description ?? null,
      instructions: body.instructions ?? "",
      avatarColor: body.avatarColor ?? null,
      avatarAccessory: body.avatarAccessory ?? null,
      sectorId: body.sectorId ?? null,
      ownerUserId: body.ownerUserId ?? db.user.id,
      isAssistant: false,
      accessMode: "workspace",
      allowedUserIds: [],
      agentsCanConsult: true,
      callableAgentsMode: "all",
      callableAgentIds: [],
      preferredCli: null,
      preferredModel: null,
      budgetTokensMonth: null,
      budgetRunsMonth: null,
      selfStartPolicy: "ask",
      maxConcurrentJobs: 2,
      maxPrsPerHour: 3,
      status: "active",
      toolPerms: { messages: "write", memory: "write", tasks: "write", wiki: "write", drive: "write", agents: "write" },
      skillIds: [],
      activity: "idle",
      createdAt: now,
      updatedAt: now,
    };
    db.agents.push(a);
    emit({ type: "agent.upserted", agent: a });
    return a;
  }, 201);
  on("GET", `${W}/agents/:id`, ({ m }) => findAgent(m[2]!));
  on("PATCH", `${W}/agents/:id`, async ({ m, body }) => {
    await sleep(200);
    const a = findAgent(m[2]!);
    const admin = me().role !== "member";
    if (!admin && a.ownerUserId !== db.user.id) throw new HttpError(403, "forbidden", "Só o responsável ou um admin muda este agente.");
    if (!admin && ("ownerUserId" in body || "budgetRunsMonth" in body || "budgetTokensMonth" in body))
      throw new HttpError(403, "forbidden", "Só admins mudam o responsável e o orçamento.");
    Object.assign(a, body, { updatedAt: Date.now() });
    emit({ type: "agent.upserted", agent: { ...a } });
    return a;
  });
  on("DELETE", `${W}/agents/:id`, ({ m }) => {
    const a = findAgent(m[2]!);
    if (a.isAssistant) throw new HttpError(400, "assistant", "O assistente pessoal não pode ser apagado.");
    db.agents = db.agents.filter((x) => x.id !== a.id);
    emit({ type: "agent.deleted", agentId: a.id });
  });
  on("GET", `${W}/agents/:id/usage`, ({ m, query }) => {
    const a = findAgent(m[2]!);
    const runs = a.handle === "tito" ? 164 : a.handle === "lia" ? 41 : 12;
    return {
      period: query.get("period") ?? new Date().toISOString().slice(0, 7),
      runs,
      inputTokens: runs * 9200,
      outputTokens: runs * 1400,
      byRunnerUser: [
        { userId: db.members[0]!.userId, runs: Math.round(runs * 0.6), tokens: Math.round(runs * 0.6 * 10600) },
        { userId: db.members[1]!.userId, runs: Math.round(runs * 0.4), tokens: Math.round(runs * 0.4 * 10600) },
      ],
    };
  });
  on("GET", `${W}/agents/:id/activity`, ({ m }) => ({ items: db.jobs.filter((j) => j.agentId === m[2]).slice(0, 20) }));
  const memList = (agentId: string | null) => db.memories.filter((x) => (agentId ? x.scope === "agent" && x.agentId === agentId : x.scope === "team"));
  const memCreate = (agentId: string | null, content: string): MemoryDTO => {
    if (!content?.trim()) throw new HttpError(400, "invalid", "Escreva o que deve ser lembrado.");
    const mem: MemoryDTO = {
      id: id("mem"),
      scope: agentId ? "agent" : "team",
      agentId,
      content,
      source: "user",
      createdBy: { type: "user", id: db.user.id },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.memories.unshift(mem);
    return mem;
  };
  const memPatch = (mid: string, content: string) => {
    const mem = db.memories.find((x) => x.id === mid);
    if (!mem) throw new HttpError(404, "not_found", "Memória não encontrada.");
    mem.content = content;
    mem.updatedAt = Date.now();
    return mem;
  };
  on("GET", `${W}/agents/:id/memories`, ({ m }) => ({ items: memList(m[2]!) }));
  on("POST", `${W}/agents/:id/memories`, ({ m, body }) => memCreate(m[2]!, body.content), 201);
  on("PATCH", `${W}/agents/:id/memories/:mid`, ({ m, body }) => memPatch(m[3]!, body.content));
  on("DELETE", `${W}/agents/:id/memories/:mid`, ({ m }) => {
    db.memories = db.memories.filter((x) => x.id !== m[3]);
  });
  on("GET", `${W}/memories`, () => ({ items: memList(null) }));
  on("POST", `${W}/memories`, ({ body }) => memCreate(null, body.content), 201);
  on("PATCH", `${W}/memories/:mid`, ({ m, body }) => memPatch(m[2]!, body.content));
  on("DELETE", `${W}/memories/:mid`, ({ m }) => {
    db.memories = db.memories.filter((x) => x.id !== m[2]);
  });

  // ---------- Jobs e aprovações ----------
  on("GET", `${W}/jobs`, ({ query }) => {
    let list = db.jobs.map(({ events: _e, ...j }) => j);
    const ch = query.get("channelId");
    const ag = query.get("agentId");
    const st = query.get("status");
    if (ch) list = list.filter((j) => j.channelId === ch);
    if (ag) list = list.filter((j) => j.agentId === ag);
    if (st) list = list.filter((j) => j.status === st);
    return { items: list };
  });
  on("POST", `${W}/jobs/:id/cancel`, ({ m }) => {
    const job = db.jobs.find((j) => j.id === m[2]);
    if (!job) throw new HttpError(404, "not_found", "Trabalho não encontrado.");
    updateJob(job, { status: "cancelled", finishedAt: Date.now() });
    const a = db.agents.find((x) => x.id === job.agentId);
    if (a) setAgentActivity(a, "idle");
  });
  on("POST", `${W}/jobs/:id/retry`, ({ m }) => {
    const job = db.jobs.find((j) => j.id === m[2]);
    if (!job) throw new HttpError(404, "not_found", "Trabalho não encontrado.");
    updateJob(job, { status: "cancelled" });
    const trigger = db.messages.find((x) => x.id === job.triggerMessageId);
    const a = db.agents.find((x) => x.id === job.agentId);
    if (trigger && a) void runJob(a, { ...trigger, body: trigger.body.replace(/erro/gi, "") });
  });
  on("GET", `${W}/approvals`, ({ query }) => {
    const st = query.get("status");
    return { items: db.approvals.filter((a) => !st || a.status === st) };
  });
  on("POST", `${W}/approvals/:id/decide`, async ({ m, body }) => {
    await sleep(250);
    const a = db.approvals.find((x) => x.id === m[2]);
    if (!a) throw new HttpError(404, "not_found", "Aprovação não encontrada.");
    if (a.status !== "pending") throw new HttpError(409, "decided", "Essa aprovação já foi decidida.");
    Object.assign(a, { status: body.decision, decidedBy: db.user.id, decidedAt: Date.now(), decisionNote: body.note ?? null });
    emit({ type: "approval.upserted", approval: { ...a } });
    const job = a.jobId ? db.jobs.find((j) => j.id === a.jobId) : undefined;
    const agent = db.agents.find((x) => x.id === a.agentId);
    if (job && agent) {
      if (body.decision === "approved") {
        const trigger = db.messages.find((x) => x.id === job.triggerMessageId);
        updateJob(job, { status: "cancelled" });
        if (trigger) void runJob(agent, { ...trigger, body: trigger.body.replace(/aprova\w*/gi, "") });
      } else {
        updateJob(job, { status: "cancelled", finishedAt: Date.now() });
        setAgentActivity(agent, "idle");
        if (job.channelId) systemMessage(job.channelId, `${db.user.name} recusou o pedido de ${agent.name}.`);
      }
    }
    return a;
  });

  // ---------- Arquivos ----------
  on("POST", `${W}/files`, async ({ body }) => {
    await sleep(300);
    const file = (body as FormData).get("file") as File;
    if (file.size > 25 * 1024 * 1024) throw new HttpError(413, "too_large", "Arquivo maior que 25 MB.");
    const f: FileDTO = {
      id: id("file"),
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      folder: ((body as FormData).get("folder") as string) || null,
      author: { type: "user", id: db.user.id },
      channelId: ((body as FormData).get("channelId") as string) || null,
      inDrive: (body as FormData).get("inDrive") !== "0",
      createdAt: Date.now(),
    };
    db.files.push(f);
    blobs.set(f.id, URL.createObjectURL(file));
    emit({ type: "file.created", file: f });
    return f;
  }, 201);

  // ---------- Notificações ----------
  on("GET", `${W}/notifications`, () => ({ items: db.notifications }));
  on("POST", `${W}/notifications/read`, ({ body }) => {
    const ids: string[] = body.ids ?? [];
    for (const n of db.notifications) if (!ids.length || ids.includes(n.id)) n.read = true;
  });

  registerAreaRoutes({
    db,
    on,
    emit,
    id,
    sleep,
    me,
    requireAdmin,
    notify,
    postMessage,
    runJob,
    setBlob: (fid, url) => blobs.set(fid, url),
    W,
  });

  async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input, location.origin);
    const path = url.pathname.replace(/^\/api/, "");
    const method = (init.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (init.body instanceof FormData) body = init.body;
    else if (typeof init.body === "string") body = JSON.parse(init.body);
    await sleep(80 + Math.random() * 120);
    for (const [mth, rx, h, status] of routes) {
      if (mth !== method) continue;
      const m = path.match(rx);
      if (!m) continue;
      try {
        if (!db.loggedIn && !path.startsWith("/auth/") && !path.startsWith("/invites/") && path !== "/me") {
          throw new HttpError(401, "unauthorized", "Entre para continuar.");
        }
        const out = await h({ m, body: body ?? {}, query: url.searchParams });
        return json(out === undefined ? 204 : status ?? 200, out);
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: { code: err.code, message: err.message } });
        console.error("[demo]", err);
        return json(500, { error: { code: "internal", message: "Erro interno do modo demonstração." } });
      }
    }
    return json(404, { error: { code: "not_found", message: `Rota ainda não existe no modo demonstração: ${method} ${path}` } });
  }

  class FakeSocket implements SocketLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() {
      setTimeout(() => {
        this.readyState = 1;
        sockets.add(this);
        this.onopen?.({});
        this.deliver({ type: "hello", userId: db.user.id, serverTime: Date.now() });
      }, 150);
    }
    deliver(event: ClientEvent) {
      if (this.readyState !== 1) return;
      const data = JSON.stringify(event);
      setTimeout(() => this.onmessage?.({ data }), 0);
    }
    send(raw: string) {
      const cmd = JSON.parse(raw);
      if (cmd.type === "read") {
        const c = db.channels.find((x) => x.id === cmd.channelId);
        if (c) c.unread = 0;
      }
    }
    close() {
      this.readyState = 3;
      sockets.delete(this);
      this.onclose?.({});
    }
  }

  // Um pouco de vida: Bruno digita de vez em quando em #geral.
  setInterval(() => {
    const geral = db.channels.find((c) => c.name === "geral");
    const bruno = db.members[1];
    if (geral && bruno && Math.random() < 0.3) emit({ type: "typing", channelId: geral.id, actor: { type: "user", id: bruno.userId } });
  }, 9000);

  // Para testar a reconexão: `window.__demoDropSocket()` no console.
  (window as unknown as { __demoDropSocket?: () => void }).__demoDropSocket = () => {
    for (const s of [...sockets]) s.close();
  };

  return {
    fetch: fakeFetch,
    createSocket: () => new FakeSocket(),
    fileUrl: (_ws: string, fileId: string) => blobs.get(fileId) ?? `data:text/plain,arquivo-de-demonstracao`,
  };
}

function replyFor(agent: AgentDTO, prompt: string): string {
  const p = prompt.replace(/@[\w-]+/g, "").trim();
  if (agent.handle === "lia") {
    return `Boa! Sobre **"${p.slice(0, 60)}"**, minha sugestão:\n\n1. Testar dois títulos curtos na newsletter de quinta.\n2. Reaproveitar o depoimento da cliente no Instagram.\n3. Medir cliques por 7 dias antes de decidir.\n\nQuer que eu rascunhe os textos?`;
  }
  return `Entendi. Olhei o que temos sobre "${p.slice(0, 60)}":\n\n- O deploy de ontem passou sem erros.\n- Há **2 PRs** esperando revisão (\`#128\` e \`#131\`).\n- Nenhum alerta aberto.\n\n\`\`\`bash\nnpm run test -w @puxibot/hub\n\`\`\`\n\nSe quiser, abro uma tarefa para revisar os PRs hoje.`;
}

function demoCards() {
  return [
    {
      type: "bars" as const,
      title: "Execuções por agente",
      subtitle: "Últimos 7 dias",
      rows: [
        { label: "Tito", value: 42 },
        { label: "Lia", value: 18 },
        { label: "Nina", value: 7 },
      ],
    },
  ];
}
