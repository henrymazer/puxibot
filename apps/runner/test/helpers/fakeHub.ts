/**
 * Hub falso para testes: HTTP (pareamento e API de ferramentas) + WebSocket do
 * runner, seguindo docs/contrato-api.md.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { HubToRunner, JobAssignment, RunnerToHub } from "@puxibot/shared";

export interface ToolCall {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | null;
  body: unknown;
  contentType: string | null;
}

export interface FakeHubOptions {
  runnerToken?: string;
  /** Quantas consultas `pending` antes de aprovar o pareamento. */
  pendingPolls?: number;
}

export class FakeHub {
  readonly received: RunnerToHub[] = [];
  readonly toolCalls: ToolCall[] = [];
  readonly hellos: Extract<RunnerToHub, { type: "hello" }>[] = [];
  /** Respostas programadas da API de ferramentas: "MÉTODO /caminho" -> [status, corpo]. */
  readonly toolResponses = new Map<string, [number, unknown]>();
  sockets = new Set<WebSocket>();
  connections = 0;
  private server: http.Server;
  private wss: WebSocketServer;
  private polls = 0;
  private waiters: { pred: (m: RunnerToHub) => boolean; resolve: (m: RunnerToHub) => void }[] = [];
  url = "";
  runnerToken: string;
  /** Faz o próximo pareamento expirar (poll responde 410). */
  expirePairing = false;

  constructor(private readonly opts: FakeHubOptions = {}) {
    this.runnerToken = opts.runnerToken ?? "tb_runner_test_secret";
    this.server = http.createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const m = /^\/api\/workspaces\/([^/]+)\/runner$/.exec(req.url ?? "");
      if (!m) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (req.headers.authorization !== `Bearer ${this.runnerToken}`) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private onSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    this.connections++;
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as RunnerToHub;
      this.received.push(msg);
      if (msg.type === "hello") {
        this.hellos.push(msg);
        this.sendTo(ws, { type: "welcome", runnerId: msg.runnerId ?? "run_1", userId: "u_1", serverTime: Date.now() });
      } else if (msg.type === "ping") {
        this.sendTo(ws, { type: "pong" });
      }
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }

  private sendTo(ws: WebSocket, msg: HubToRunner): void {
    ws.send(JSON.stringify(msg));
  }

  send(msg: HubToRunner): void {
    for (const ws of this.sockets) this.sendTo(ws, msg);
  }

  assign(a: JobAssignment): void {
    this.send({ type: "job.assign", assignment: a });
  }

  /** Derruba todas as conexões (simula queda de rede). */
  dropAll(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  waitFor<T extends RunnerToHub["type"]>(
    type: T,
    pred: (m: Extract<RunnerToHub, { type: T }>) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<Extract<RunnerToHub, { type: T }>> {
    const already = this.received.find((m) => m.type === type && pred(m as Extract<RunnerToHub, { type: T }>));
    if (already) return Promise.resolve(already as Extract<RunnerToHub, { type: T }>);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout esperando ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Extract<RunnerToHub, { type: T }>),
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as Extract<RunnerToHub, { type: T }>);
        },
      });
    });
  }

  of<T extends RunnerToHub["type"]>(type: T, jobId?: string): Extract<RunnerToHub, { type: T }>[] {
    return this.received.filter(
      (m) => m.type === type && (jobId === undefined || (m as { jobId?: string }).jobId === jobId),
    ) as Extract<RunnerToHub, { type: T }>[];
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const ct = req.headers["content-type"] ?? null;
    let body: unknown = null;
    if (ct?.includes("application/json") && raw.length) body = JSON.parse(raw.toString("utf8"));
    else if (raw.length) body = raw.toString("utf8");
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === "/api/runner/pair/start" && req.method === "POST") {
      return json(201, { pairCode: "QX7-42K", pollToken: this.expirePairing ? "poll_expired" : "poll_secret", expiresAt: Date.now() + 600_000 });
    }
    if (url.pathname === "/api/runner/pair/poll" && req.method === "POST") {
      if ((body as { pollToken?: string })?.pollToken !== "poll_secret") return json(410, { error: { code: "pairing_expired", message: "pareamento expirado" } });
      this.polls++;
      if (this.polls <= (this.opts.pendingPolls ?? 2)) return json(200, { status: "pending" });
      return json(200, { status: "approved", token: this.runnerToken, workspaceId: "ws_1", hubUrl: this.url });
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
      if (req.headers.authorization !== `Bearer ${this.runnerToken}`) return json(401, { error: { code: "unauthorized", message: "token inválido" } });
      return json(200, { user: { id: "u_1", name: "Renato" }, workspaces: [{ id: "ws_1" }, { id: "ws_9" }] });
    }
    if (url.pathname.startsWith("/api/workspaces/") && req.headers.authorization?.startsWith("Bearer tb_")) {
      // Contrato: token de runner só vale no WebSocket e em GET /api/me.
      return json(403, { error: { code: "runner_token_not_allowed", message: "token de runner não vale aqui" } });
    }
    if (url.pathname.startsWith("/api/tool/")) {
      const call: ToolCall = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization ?? null,
        body,
        contentType: ct,
      };
      this.toolCalls.push(call);
      if (!call.auth?.startsWith("Bearer tbj_")) return json(401, { error: { code: "unauthorized", message: "token de job inválido" } });
      const programmed = this.toolResponses.get(`${call.method} ${call.path}`);
      if (programmed) return json(programmed[0], programmed[1]);
      if (call.path === "/api/tool/channels") return json(200, { items: [{ id: "c_1", name: "geral" }, { id: "c_2", name: "dev" }] });
      if (call.path === "/api/tool/progress") return json(201, { ok: true });
      return json(200, { ok: true, echo: body });
    }
    json(404, { error: { code: "not_found", message: "rota desconhecida" } });
  }
}

export function makeAssignment(hubUrl: string, over: Partial<JobAssignment> = {}): JobAssignment {
  const jobId = over.jobId ?? `job_${Math.random().toString(36).slice(2, 10)}`;
  return {
    jobId,
    jobToken: "tbj_job_secret_value",
    hubUrl,
    workspace: { id: "ws_1", name: "Time Teste" },
    agent: {
      id: "ag_1",
      handle: "marcos",
      name: "Marcos",
      role: "Engenharia",
      instructions: "Seja breve.",
      isAssistant: false,
      preferredCli: null,
      preferredModel: null,
      toolPerms: { messages: "write", memory: "write", tasks: "write", wiki: "write", drive: "write", agents: "write" },
      skills: [{ name: "Revisar PR", description: "Como revisar um pull request", body: "Leia o diff com calma." }],
    },
    origin: "user",
    requestedBy: { userId: "u_1", name: "Renato" },
    channel: { id: "c_1", kind: "channel", name: "geral" },
    threadRootId: null,
    prompt: "Quantos canais temos?",
    context: [{ author: "Renato", authorType: "user", body: "Oi time", createdAt: Date.now() - 60_000 }],
    memories: [
      { scope: "agent", content: "Renato prefere respostas curtas." },
      { scope: "team", content: "O time usa TypeScript." },
    ],
    teammates: [{ handle: "tito", name: "Tito", role: "PM" }],
    connectors: [],
    sessionKey: `ag_1:c_1`,
    timeoutMs: 60_000,
    ...over,
  };
}
