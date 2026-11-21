import { exports } from "cloudflare:workers";
import type { BootstrapDTO, ChannelDTO, ClientEvent, HubToRunner, RunnerToHub, WorkspaceDTO } from "@puxibot/shared";
import { RUNNER_PROTOCOL_VERSION } from "@puxibot/shared";

export const BASE = "http://localhost";

let counter = 0;
export function uniq(prefix = "u"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(BASE + path, init));
}

/** Cliente HTTP com cookie de sessão. */
export class Client {
  cookie: string | null = null;
  userId = "";

  async req<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("Set-Cookie");
    if (setCookie) {
      const m = /tb_session=([^;]*)/.exec(setCookie);
      if (m) this.cookie = m[1] ? `tb_session=${m[1]}` : null;
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  get<T = unknown>(path: string) {
    return this.req<T>("GET", path);
  }
  post<T = unknown>(path: string, body: unknown = {}) {
    return this.req<T>("POST", path, body);
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.req<T>("PATCH", path, body);
  }
  del<T = unknown>(path: string, body?: unknown) {
    return this.req<T>("DELETE", path, body);
  }
}

export async function signup(name = "Ana Souza", inviteCode?: string): Promise<Client> {
  const c = new Client();
  const res = await c.post<{ user: { id: string } }>("/api/auth/signup", {
    email: `${uniq("p")}@exemplo.com`,
    name,
    password: "senha-forte-123",
    ...(inviteCode ? { inviteCode } : {}),
  });
  if (res.status !== 201) throw new Error(`signup falhou: ${res.status} ${JSON.stringify(res.body)}`);
  c.userId = res.body.user.id;
  return c;
}

export async function createWorkspace(c: Client, name = "Time"): Promise<WorkspaceDTO> {
  const res = await c.post<WorkspaceDTO>("/api/workspaces", { name, kind: "team" });
  if (res.status !== 201) throw new Error(`workspace falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function bootstrap(c: Client, wsId: string): Promise<BootstrapDTO> {
  const res = await c.get<BootstrapDTO>(`/api/workspaces/${wsId}/bootstrap`);
  if (res.status !== 200) throw new Error(`bootstrap falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function general(c: Client, wsId: string): Promise<ChannelDTO> {
  const b = await bootstrap(c, wsId);
  return b.channels.find((ch) => ch.name === "general")!;
}

/** WebSocket de teste com fila de mensagens recebidas. */
export class TestSocket<In, Out> {
  received: In[] = [];
  private waiters: { pred: (m: In) => boolean; resolve: (m: In) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) as In;
      this.received.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }

  send(msg: Out): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor<T extends In = In>(pred: (m: In) => boolean, timeoutMs = 5000): Promise<T> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout esperando mensagem no WebSocket")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
      });
    });
  }

  close(): void {
    try {
      this.ws.close(1000, "fim");
    } catch {
      // ignore
    }
  }
}

export async function openBrowserSocket(c: Client, wsId: string): Promise<TestSocket<ClientEvent, unknown>> {
  const res = await call(`/api/workspaces/${wsId}/realtime`, { headers: { Upgrade: "websocket", Cookie: c.cookie ?? "" } });
  if (res.status !== 101 || !res.webSocket) throw new Error(`realtime falhou: ${res.status} ${await res.text()}`);
  const sock = new TestSocket<ClientEvent, unknown>(res.webSocket);
  await sock.waitFor((m) => m.type === "hello");
  return sock;
}

export async function createRunnerToken(c: Client, wsId: string): Promise<string> {
  const res = await c.post<{ token: string }>(`/api/workspaces/${wsId}/tokens`, { name: "notebook", kind: "runner" });
  if (res.status !== 201) throw new Error(`token falhou: ${res.status}`);
  return res.body.token;
}

export type RunnerSocket = TestSocket<HubToRunner, RunnerToHub>;

/** Runner falso: conecta, manda hello e espera welcome. */
export async function connectRunner(
  token: string,
  wsId: string,
  opts: { capacity?: number; runnerId?: string | null; clis?: ("claude" | "codex" | "gemini")[] } = {},
): Promise<{ sock: RunnerSocket; runnerId: string }> {
  const res = await call(`/api/workspaces/${wsId}/runner`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
  });
  if (res.status !== 101 || !res.webSocket) throw new Error(`runner falhou: ${res.status} ${await res.text()}`);
  const sock: RunnerSocket = new TestSocket(res.webSocket);
  sock.send({
    type: "hello",
    protocol: RUNNER_PROTOCOL_VERSION,
    runnerId: opts.runnerId ?? null,
    name: "notebook-teste",
    platform: "linux",
    clis: (opts.clis ?? ["claude"]).map((cli) => ({ cli, version: "1.0.0", loggedIn: true })),
    isolation: "sandbox",
    capacity: opts.capacity ?? 2,
  });
  const welcome = await sock.waitFor<Extract<HubToRunner, { type: "welcome" }>>((m) => m.type === "welcome");
  return { sock, runnerId: welcome.runnerId };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Espera até a condição assíncrona ser verdadeira. */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("condição não satisfeita a tempo");
    await sleep(25);
  }
}

// ---------- Segunda leva ----------
type AssignMsg = Extract<HubToRunner, { type: "job.assign" }>;

/** Requisição com token (job `tbj_` ou pessoal `tb_`). */
export async function tokenReq<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export async function createAgentFor(c: Client, wsId: string, name = "Marcos", extra: Record<string, unknown> = {}) {
  const res = await c.post<import("@puxibot/shared").AgentDTO>(`/api/workspaces/${wsId}/agents`, {
    handle: uniq(name.toLowerCase()).toLowerCase().slice(0, 30),
    name,
    role: "Engenharia",
    ...extra,
  });
  if (res.status !== 201) throw new Error(`agente falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Coloca um job do agente em execução: DM com o agente, runner falso conectado, `job.accepted`.
 * Devolve o token de job e o socket do runner.
 */
export async function runningJob(c: Client, wsId: string, agentId: string, body = "Oi", runner?: { sock: RunnerSocket }) {
  const conn = runner ?? (await connectRunner(await createRunnerToken(c, wsId), wsId, { capacity: 4 }));
  const dm = await c.post<ChannelDTO>(`/api/workspaces/${wsId}/dms`, { with: { type: "agent", id: agentId } });
  const before = conn.sock.received.length;
  await c.post(`/api/workspaces/${wsId}/channels/${dm.body.id}/messages`, { body });
  const assign = await conn.sock.waitFor<AssignMsg>(
    (m) => m.type === "job.assign" && m.assignment.agent.id === agentId && conn.sock.received.indexOf(m) >= before,
  );
  conn.sock.send({ type: "job.accepted", jobId: assign.assignment.jobId, cli: "claude", model: "haiku" });
  await eventually(async () => {
    const r = await c.get<{ items: { id: string; status: string }[] }>(`/api/workspaces/${wsId}/jobs?agentId=${agentId}`);
    return r.body.items.find((j) => j.id === assign.assignment.jobId && j.status === "running");
  });
  return { token: assign.assignment.jobToken, jobId: assign.assignment.jobId, assignment: assign.assignment, sock: conn.sock, dmId: dm.body.id };
}
