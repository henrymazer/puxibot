import { DurableObject } from "cloudflare:workers";
import {
  CLIS,
  ISOLATION_MODES,
  CHILD_JOB_EXTRA_CAPACITY,
  JOB_LEASE_MS,
  JOB_MAX_ATTEMPTS,
  RUNNER_PROTOCOL_VERSION,
  type ClientCommand,
  type ClientEvent,
  type Cli,
  type HubToRunner,
  type JobErrorCode,
  type RunnerDTO,
  type RunnerToHub,
} from "@puxibot/shared";
import { publicUrl, type AppEnv } from "../env";
import { all, first, newId, run } from "../lib/db";
import type { HubCtx, Presence, Realtime } from "../domain/context";
import { canTalkTo, getAgentRow, maybeWarnBudget } from "../domain/agents";
import { buildAssignment } from "../domain/assignment";
import { canSeeChannel, channelAudience, getChannel } from "../domain/channels";
import { getJobRow, jobAudience, publishJob } from "../domain/jobs";
import { insertMessage, postSystemMessage } from "../domain/messages";
import { backfillRoutineSchedules, fireDueRoutines, nextRoutineRunAt } from "../domain/routines";
import { addTaskComment } from "../domain/tasks";
import { sanitizeCards } from "../domain/cards";
import { links, notify } from "../domain/notify";
import { toJobEventDTO, toRunnerDTO, type AgentRow, type JobRow, type RunnerRow } from "../domain/rows";

/** Cabeçalhos que o Worker define ao repassar um upgrade de WebSocket já autenticado. */
export const HUB_HEADERS = {
  kind: "X-Puxibot-Kind", // 'browser' | 'runner'
  user: "X-Puxibot-User",
  workspace: "X-Puxibot-Workspace",
  token: "X-Puxibot-Token-Id",
  origin: "X-Puxibot-Origin",
} as const;

interface BrowserAttachment {
  kind: "browser";
  userId: string;
}

interface RunnerAttachment {
  kind: "runner";
  userId: string;
  tokenId: string;
  origin: string;
  /** null até o `hello`. */
  runnerId: string | null;
  name: string;
  capacity: number;
  /** CLIs disponíveis (exclui as com `loggedIn === false`). */
  clis: Cli[];
}

type Attachment = BrowserAttachment | RunnerAttachment;

const MAX_RUNNER_CAPACITY = 16;
/** Conexões abertas por pessoa (abas do navegador / runners). Ao passar, a mais antiga é fechada. */
const MAX_BROWSER_SOCKETS_PER_USER = 20;
const MAX_RUNNER_SOCKETS_PER_USER = 5;
/** Limites do que o runner manda (o texto vira mensagem e evento para todo o canal). */
const MAX_RESULT_CHARS = 100_000;
const MAX_STREAM_CHARS = 100_000;
const MAX_MODEL_CHARS = 100;

function cleanCli(v: unknown): Cli | null {
  return typeof v === "string" && (CLIS as readonly string[]).includes(v) ? (v as Cli) : null;
}

function cleanModel(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_MODEL_CHARS) : null;
}

/**
 * Um por workspace (`getByName(workspaceId)`). Mantém os WebSockets hibernáveis de navegadores e runners,
 * presença, distribuição de eventos e o ciclo de vida dos jobs (fila, entrega, lease com alarme, resultados).
 * O estado durável fica no D1; aqui só o que é derivável das conexões.
 *
 * Toda mudança de job passa por `serial()` para não entregar o mesmo job duas vezes enquanto uma
 * chamada ao D1 está em andamento (o D1 é I/O externo e não segura a input gate do DO).
 */
export class WorkspaceHub extends DurableObject<AppEnv> {
  private wsId: string | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private needsPump = false;
  /** Runners que recusaram um job (em memória; só evita reentregar ao mesmo runner logo em seguida). */
  private rejectedBy = new Map<string, Set<string>>();
  private jobCache = new Map<string, { channelId: string | null; agentId: string; runnerId: string | null; audience: string[] | null }>();

  // ---------- Infra ----------
  private async workspaceId(wsId?: string): Promise<string> {
    if (wsId) {
      if (this.wsId !== wsId) {
        this.wsId = wsId;
        await this.ctx.storage.put("workspaceId", wsId);
      }
      return wsId;
    }
    if (!this.wsId) this.wsId = (await this.ctx.storage.get<string>("workspaceId")) ?? null;
    if (!this.wsId) throw new Error("WorkspaceHub sem workspaceId");
    return this.wsId;
  }

  private domainCtx(wsId: string): HubCtx {
    const rt: Realtime = {
      publish: async (event, audience) => this.broadcast(event, audience),
      // Dentro do DO o pump é adiado para o fim da seção serial em andamento.
      pump: async () => {
        this.needsPump = true;
      },
      presence: async () => this.currentPresence(),
      cancelOnRunner: async (jobId, runnerId) => this.sendToRunner(runnerId, { type: "job.cancel", jobId }),
      disconnectRunner: async (runnerId) => this.closeRunner(runnerId),
      disconnectUser: async (userId) => this.closeUser(userId),
    };
    return { env: this.env, wsId, rt };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.lock.then(async () => {
      const result = await fn();
      let guard = 0;
      while (this.needsPump && guard++ < 10) {
        this.needsPump = false;
        await this.doPump(await this.workspaceId());
      }
      await this.scheduleAlarm(await this.workspaceId());
      return result;
    });
    this.lock = task.catch((err) => {
      console.error(JSON.stringify({ msg: "WorkspaceHub task failed", error: String(err), stack: (err as Error)?.stack }));
    });
    return task;
  }

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private openSockets(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((s) => s.readyState === WebSocket.OPEN);
  }

  private readyRunners(): { ws: WebSocket; att: RunnerAttachment & { runnerId: string } }[] {
    const out: { ws: WebSocket; att: RunnerAttachment & { runnerId: string } }[] = [];
    for (const ws of this.openSockets("runner")) {
      const att = this.attachment(ws);
      if (att?.kind === "runner" && att.runnerId) out.push({ ws, att: att as RunnerAttachment & { runnerId: string } });
    }
    return out;
  }

  private send(ws: WebSocket, msg: HubToRunner | ClientEvent): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // conexão fechando; o close handler cuida do resto
    }
  }

  private sendToRunner(runnerId: string, msg: HubToRunner): void {
    for (const r of this.readyRunners()) if (r.att.runnerId === runnerId) this.send(r.ws, msg);
  }

  private broadcast(event: ClientEvent, audience: string[] | null, exceptUserId?: string): void {
    const data = JSON.stringify(event);
    const allowed = audience ? new Set(audience) : null;
    for (const ws of this.openSockets("browser")) {
      const att = this.attachment(ws);
      if (att?.kind !== "browser") continue;
      if (allowed && !allowed.has(att.userId)) continue;
      if (exceptUserId && att.userId === exceptUserId) continue;
      try {
        ws.send(data);
      } catch {
        // ignorado
      }
    }
  }

  private currentPresence(exclude?: WebSocket): Presence {
    const online = new Set<string>();
    for (const ws of this.openSockets("browser")) {
      if (ws === exclude) continue;
      const att = this.attachment(ws);
      if (att?.kind === "browser") online.add(att.userId);
    }
    const runners = this.readyRunners()
      .filter((r) => r.ws !== exclude)
      .map((r) => ({ runnerId: r.att.runnerId, userId: r.att.userId }));
    return { onlineUserIds: [...online], runners };
  }

  private publishPresence(userId: string, exclude?: WebSocket): void {
    const p = this.currentPresence(exclude);
    this.broadcast(
      { type: "presence", userId, online: p.onlineUserIds.includes(userId), runnerOnline: p.runners.some((r) => r.userId === userId) },
      null,
    );
  }

  private closeRunner(runnerId: string): void {
    for (const r of this.readyRunners()) {
      if (r.att.runnerId === runnerId) {
        try {
          r.ws.close(4001, "Runner removido");
        } catch {
          // já fechado
        }
      }
    }
  }

  private closeUser(userId: string): void {
    for (const tag of [`u:${userId}`, `ru:${userId}`]) {
      for (const ws of this.ctx.getWebSockets(tag)) {
        try {
          ws.close(4003, "Acesso ao workspace removido");
        } catch {
          // já fechado
        }
      }
    }
  }

  // ---------- RPC (chamado pelas rotas HTTP) ----------
  async publish(wsId: string, event: ClientEvent, audience: string[] | null): Promise<void> {
    await this.workspaceId(wsId);
    this.broadcast(event, audience);
  }

  async pump(wsId: string): Promise<void> {
    await this.workspaceId(wsId);
    await this.serial(async () => {
      this.needsPump = true;
    });
  }

  async presence(wsId: string): Promise<Presence> {
    await this.workspaceId(wsId);
    return this.currentPresence();
  }

  async cancelOnRunner(wsId: string, jobId: string, runnerId: string): Promise<void> {
    await this.workspaceId(wsId);
    this.jobCache.delete(jobId);
    this.sendToRunner(runnerId, { type: "job.cancel", jobId });
  }

  async disconnectRunner(wsId: string, runnerId: string): Promise<void> {
    await this.workspaceId(wsId);
    this.closeRunner(runnerId);
  }

  async disconnectUser(wsId: string, userId: string): Promise<void> {
    await this.workspaceId(wsId);
    this.closeUser(userId);
  }

  // ---------- WebSockets ----------
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Esperado upgrade para WebSocket", { status: 426 });
    }
    const kind = request.headers.get(HUB_HEADERS.kind);
    const userId = request.headers.get(HUB_HEADERS.user);
    const wsIdHeader = request.headers.get(HUB_HEADERS.workspace);
    if (!userId || !wsIdHeader || (kind !== "browser" && kind !== "runner")) {
      return new Response("Requisição inválida", { status: 400 });
    }
    await this.workspaceId(wsIdHeader);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Limite de conexões por pessoa: ao passar, fecha a(s) mais antiga(s).
    const tag = kind === "browser" ? `u:${userId}` : `ru:${userId}`;
    const max = kind === "browser" ? MAX_BROWSER_SOCKETS_PER_USER : MAX_RUNNER_SOCKETS_PER_USER;
    const open = this.ctx.getWebSockets(tag).filter((s) => s.readyState === WebSocket.OPEN);
    for (const old of open.slice(0, Math.max(0, open.length - max + 1))) {
      try {
        old.close(4008, "Conexões demais abertas");
      } catch {
        // já fechado
      }
    }

    if (kind === "browser") {
      const firstConnection = this.ctx.getWebSockets(`u:${userId}`).length === 0;
      this.ctx.acceptWebSocket(server, ["browser", `u:${userId}`]);
      server.serializeAttachment({ kind: "browser", userId } satisfies BrowserAttachment);
      this.send(server, { type: "hello", userId, serverTime: Date.now() });
      if (firstConnection) this.publishPresence(userId);
    } else {
      this.ctx.acceptWebSocket(server, ["runner", `ru:${userId}`]);
      server.serializeAttachment({
        kind: "runner",
        userId,
        tokenId: request.headers.get(HUB_HEADERS.token) ?? "",
        origin: request.headers.get(HUB_HEADERS.origin) ?? "",
        runnerId: null,
        name: "",
        capacity: 1,
        clis: [],
      } satisfies RunnerAttachment);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.attachment(ws);
    if (!att) return;
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > 2 * 1024 * 1024) {
      if (att.kind === "runner") this.send(ws, { type: "error", code: "message_too_large", message: "Mensagem grande demais." });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      if (att.kind === "runner") this.send(ws, { type: "error", code: "invalid_json", message: "Mensagem não é um JSON válido." });
      return;
    }
    const wsId = await this.workspaceId();
    if (att.kind === "browser") return this.onBrowserCommand(wsId, ws, att, parsed as ClientCommand);
    if ((parsed as { type?: unknown })?.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }
    return this.serial(() => this.onRunnerMessage(wsId, ws, att, parsed as RunnerToHub));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // já fechado
    }
    await this.onSocketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const att = this.attachment(ws);
    if (!att) return;
    const wsId = await this.workspaceId();
    if (att.kind === "browser") {
      const stillOnline = this.ctx.getWebSockets(`u:${att.userId}`).some((s) => s !== ws && s.readyState === WebSocket.OPEN);
      if (!stillOnline) this.publishPresence(att.userId, ws);
      return;
    }
    if (!att.runnerId) return;
    const runnerId = att.runnerId;
    const replaced = this.readyRunners().some((r) => r.ws !== ws && r.att.runnerId === runnerId);
    if (replaced) return;
    await this.serial(async () => {
      await run(
        this.env.DB,
        "UPDATE runners SET online = 0, last_seen_at = ? WHERE workspace_id = ? AND id = ?",
        Date.now(),
        wsId,
        runnerId,
      );
      await this.publishRunner(wsId, runnerId, false);
      this.publishPresence(att.userId, ws);
      const jobs = await all<JobRow>(
        this.env.DB,
        "SELECT * FROM jobs WHERE workspace_id = ? AND runner_id = ? AND status IN ('assigned','running')",
        wsId,
        runnerId,
      );
      for (const job of jobs) await this.requeueOrFail(wsId, job, "O runner desconectou durante a execução.");
      this.needsPump = true;
    });
  }

  private async onBrowserCommand(wsId: string, ws: WebSocket, att: BrowserAttachment, cmd: ClientCommand): Promise<void> {
    if (!cmd || typeof cmd !== "object") return;
    if (cmd.type === "typing" && typeof cmd.channelId === "string") {
      const ch = await getChannel(this.env.DB, wsId, cmd.channelId);
      if (!ch || !(await canSeeChannel(this.env.DB, ch, att.userId))) return;
      this.broadcast(
        { type: "typing", channelId: ch.id, actor: { type: "user", id: att.userId } },
        await channelAudience(this.env.DB, ch),
        att.userId,
      );
    } else if (cmd.type === "read" && typeof cmd.channelId === "string") {
      await run(
        this.env.DB,
        `UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND member_type = 'user' AND member_id = ?
           AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)`,
        Date.now(),
        cmd.channelId,
        att.userId,
        wsId,
      );
    }
    void ws;
  }

  // ---------- Protocolo do runner ----------
  private async onRunnerMessage(wsId: string, ws: WebSocket, att: RunnerAttachment, msg: RunnerToHub): Promise<void> {
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
      this.send(ws, { type: "error", code: "invalid_message", message: "Mensagem sem tipo." });
      return;
    }
    if (msg.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }
    if (msg.type === "hello") return this.onHello(wsId, ws, att, msg);
    if (!att.runnerId) {
      this.send(ws, { type: "error", code: "hello_required", message: "Envie hello antes de qualquer outra mensagem." });
      return;
    }
    const runnerId = att.runnerId;
    switch (msg.type) {
      case "job.accepted":
        return this.onAccepted(wsId, runnerId, msg.jobId, msg.cli, msg.model);
      case "job.rejected": {
        const job = await this.ownedJob(wsId, runnerId, msg.jobId);
        if (!job) return;
        const set = this.rejectedBy.get(job.id) ?? new Set<string>();
        set.add(runnerId);
        this.rejectedBy.set(job.id, set);
        await this.requeueOrFail(wsId, job, `O runner recusou o trabalho: ${msg.reason}`, false);
        this.needsPump = true;
        return;
      }
      case "job.heartbeat":
        await run(
          this.env.DB,
          `UPDATE jobs SET lease_expires_at = ? WHERE workspace_id = ? AND id = ? AND runner_id = ?
             AND status IN ('assigned','running')`,
          Date.now() + JOB_LEASE_MS,
          wsId,
          msg.jobId,
          runnerId,
        );
        return;
      case "job.stream": {
        const meta = await this.jobMeta(wsId, msg.jobId);
        if (!meta || meta.runnerId !== runnerId) return;
        this.broadcast(
          { type: "job.stream", jobId: msg.jobId, channelId: meta.channelId, agentId: meta.agentId, text: String(msg.text ?? "").slice(0, MAX_STREAM_CHARS) },
          meta.audience,
        );
        return;
      }
      case "job.event": {
        const meta = await this.jobMeta(wsId, msg.jobId);
        if (!meta || meta.runnerId !== runnerId) return;
        const kind = msg.kind === "tool" || msg.kind === "status" ? msg.kind : "note";
        const row = await first<{ id: number; created_at: number }>(
          this.env.DB,
          "INSERT INTO job_events (job_id, kind, summary, created_at) VALUES (?, ?, ?, ?) RETURNING id, created_at",
          msg.jobId,
          kind,
          String(msg.summary ?? "").slice(0, 2000),
          Date.now(),
        );
        if (row) {
          this.broadcast(
            {
              type: "job.event",
              event: toJobEventDTO({ id: row.id, job_id: msg.jobId, kind, summary: String(msg.summary ?? "").slice(0, 2000), created_at: row.created_at }),
            },
            meta.audience,
          );
        }
        return;
      }
      case "job.done":
        return this.onDone(wsId, att, runnerId, msg);
      case "job.failed":
        return this.onFailed(wsId, runnerId, msg.jobId, msg.errorCode, msg.error);
      default:
        this.send(ws, { type: "error", code: "unknown_type", message: "Tipo de mensagem desconhecido." });
    }
  }

  private async onHello(wsId: string, ws: WebSocket, att: RunnerAttachment, msg: Extract<RunnerToHub, { type: "hello" }>) {
    if (msg.protocol !== RUNNER_PROTOCOL_VERSION) {
      this.send(ws, {
        type: "error",
        code: "protocol_mismatch",
        message: `Versão de protocolo não suportada (hub: ${RUNNER_PROTOCOL_VERSION}). Atualize o runner.`,
      });
      ws.close(4000, "protocol_mismatch");
      return;
    }
    const db = this.env.DB;
    const now = Date.now();
    // Tudo que o runner declara vai para o banco e para a interface: só valores conhecidos e curtos.
    const clis: RunnerDTO["clis"] = [];
    for (const c of Array.isArray(msg.clis) ? msg.clis.slice(0, 10) : []) {
      const cli = cleanCli((c as { cli?: unknown } | null)?.cli);
      if (!cli || clis.some((x) => x.cli === cli)) continue;
      const version = (c as { version?: unknown }).version;
      const loggedIn = (c as { loggedIn?: unknown }).loggedIn;
      clis.push({ cli, version: typeof version === "string" ? version.slice(0, 40) : null, loggedIn: typeof loggedIn === "boolean" ? loggedIn : null });
    }
    const name = String(msg.name ?? "runner").slice(0, 80) || "runner";
    const platform = typeof msg.platform === "string" ? msg.platform.slice(0, 40) : null;
    const isolation = (ISOLATION_MODES as readonly string[]).includes(String(msg.isolation)) ? msg.isolation : null;
    let runner: RunnerRow | null = null;
    if (msg.runnerId) {
      runner = await first<RunnerRow>(
        db,
        "SELECT * FROM runners WHERE workspace_id = ? AND id = ? AND user_id = ?",
        wsId,
        msg.runnerId,
        att.userId,
      );
    }
    const runnerId = runner?.id ?? newId();
    if (runner) {
      await run(
        db,
        `UPDATE runners SET name = ?, platform = ?, clis_json = ?, isolation = ?, online = 1, last_seen_at = ?, token_id = ?
         WHERE workspace_id = ? AND id = ?`,
        name,
        platform,
        JSON.stringify(clis),
        isolation,
        now,
        att.tokenId || null,
        wsId,
        runnerId,
      );
    } else {
      await run(
        db,
        `INSERT INTO runners (id, workspace_id, user_id, name, platform, clis_json, isolation, online, last_seen_at, created_at, token_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        runnerId,
        wsId,
        att.userId,
        name,
        platform,
        JSON.stringify(clis),
        isolation,
        now,
        now,
        att.tokenId || null,
      );
    }
    // Uma conexão por runner: a antiga é substituída.
    for (const other of this.readyRunners()) {
      if (other.ws !== ws && other.att.runnerId === runnerId) {
        try {
          other.ws.close(4002, "Substituído por nova conexão");
        } catch {
          // já fechado
        }
      }
    }
    const updated: RunnerAttachment = {
      ...att,
      runnerId,
      name,
      capacity: Math.max(1, Math.min(MAX_RUNNER_CAPACITY, Math.trunc(Number(msg.capacity) || 1))),
      clis: clis.filter((c) => c && c.loggedIn !== false).map((c) => c.cli),
    };
    ws.serializeAttachment(updated);
    this.send(ws, { type: "welcome", runnerId, userId: att.userId, serverTime: now });
    await this.publishRunner(wsId, runnerId, true);
    this.publishPresence(att.userId);
    this.needsPump = true;
  }

  private async publishRunner(wsId: string, runnerId: string, online: boolean): Promise<void> {
    const row = await first<RunnerRow>(this.env.DB, "SELECT * FROM runners WHERE workspace_id = ? AND id = ?", wsId, runnerId);
    if (row) this.broadcast({ type: "runner.updated", runner: toRunnerDTO(row, online) }, null);
  }

  private async ownedJob(wsId: string, runnerId: string, jobId: string): Promise<JobRow | null> {
    if (typeof jobId !== "string") return null;
    const job = await getJobRow(this.env.DB, wsId, jobId);
    if (!job || job.runner_id !== runnerId || (job.status !== "assigned" && job.status !== "running")) return null;
    return job;
  }

  private async jobMeta(wsId: string, jobId: string) {
    if (typeof jobId !== "string") return null;
    let meta = this.jobCache.get(jobId);
    if (!meta) {
      const job = await getJobRow(this.env.DB, wsId, jobId);
      if (!job || (job.status !== "assigned" && job.status !== "running")) return null;
      meta = {
        channelId: job.channel_id,
        agentId: job.agent_id,
        runnerId: job.runner_id,
        audience: await jobAudience(this.domainCtx(wsId), job),
      };
      this.jobCache.set(jobId, meta);
    }
    return meta;
  }

  private async onAccepted(wsId: string, runnerId: string, jobId: string, cli: Cli, model: string | null) {
    const now = Date.now();
    const changed = await run(
      this.env.DB,
      `UPDATE jobs SET status = 'running', cli = ?, model = ?, started_at = COALESCE(started_at, ?), lease_expires_at = ?
       WHERE workspace_id = ? AND id = ? AND runner_id = ? AND status = 'assigned'`,
      cleanCli(cli),
      cleanModel(model),
      now,
      now + JOB_LEASE_MS,
      wsId,
      jobId,
      runnerId,
    );
    if (changed === 0) return;
    const job = await getJobRow(this.env.DB, wsId, jobId);
    if (job) await publishJob(this.domainCtx(wsId), job);
  }

  private async onDone(
    wsId: string,
    att: RunnerAttachment,
    runnerId: string,
    msg: Extract<RunnerToHub, { type: "job.done" }>,
  ): Promise<void> {
    const db = this.env.DB;
    const now = Date.now();
    const text = String(msg.text ?? "").slice(0, MAX_RESULT_CHARS);
    const tokens = (v: unknown) => Math.min(1_000_000_000, Math.max(0, Math.trunc(Number(v) || 0)));
    const changed = await run(
      db,
      `UPDATE jobs SET status = 'done', input_tokens = ?, output_tokens = ?, model = COALESCE(?, model), result_text = ?,
         finished_at = ?, lease_expires_at = NULL
       WHERE workspace_id = ? AND id = ? AND runner_id = ? AND status IN ('assigned','running')`,
      tokens(msg.inputTokens),
      tokens(msg.outputTokens),
      cleanModel(msg.model),
      text,
      now,
      wsId,
      msg.jobId,
      runnerId,
    );
    if (changed === 0) return;
    this.jobCache.delete(msg.jobId);
    this.rejectedBy.delete(msg.jobId);
    const ctx = this.domainCtx(wsId);
    const job = (await getJobRow(db, wsId, msg.jobId))!;
    const agent = await getAgentRow(db, wsId, job.agent_id);
    if (job.channel_id && text.trim() && agent) {
      const channel = await getChannel(db, wsId, job.channel_id);
      if (channel) {
        await insertMessage(ctx, {
          channel,
          author: { type: "agent", id: agent.id },
          body: text,
          threadRootId: job.thread_root_id,
          cards: sanitizeCards(msg.cards),
          jobId: job.id,
          meta: {
            ...(job.cli ? { cli: job.cli } : {}),
            ...(job.model ? { model: job.model } : {}),
            ...(job.runner_user_id ? { runnerUserId: job.runner_user_id } : {}),
            runnerName: att.name,
          },
        });
        await this.notifyReply(ctx, job, agent, channel.kind, channel.name);
      }
    } else if (job.task_id && text.trim() && agent) {
      // Job de tarefa sem conversa: a resposta vira comentário na tarefa.
      await addTaskComment(ctx, job.task_id, {
        author: { type: "agent", id: agent.id },
        body: text,
        onBehalfOfUserId: job.requested_by_user_id,
        triggerJobs: false,
      });
    }
    await publishJob(ctx, job);
    await maybeWarnBudget(ctx, job.agent_id);
    this.needsPump = true;
  }

  /** Avisa quem pediu que o agente respondeu, se a pessoa não estiver com o app aberto. */
  private async notifyReply(ctx: HubCtx, job: JobRow, agent: AgentRow, kind: "channel" | "dm", channelName: string | null) {
    const userId = job.requested_by_user_id;
    if (!userId || !job.channel_id) return;
    if (this.currentPresence().onlineUserIds.includes(userId)) return;
    await notify(ctx, {
      userId,
      kind: kind === "dm" ? "dm" : "mention",
      title: kind === "dm" ? `${agent.name} respondeu` : `${agent.name} respondeu em #${channelName ?? "canal"}`,
      link: links.channel(ctx.wsId, job.channel_id),
    });
  }

  private async onFailed(wsId: string, runnerId: string, jobId: string, errorCode: JobErrorCode, error: string) {
    const code: JobErrorCode = ["auth", "limit", "timeout", "runner_lost", "error"].includes(errorCode) ? errorCode : "error";
    const changed = await run(
      this.env.DB,
      `UPDATE jobs SET status = 'failed', error = ?, error_code = ?, finished_at = ?, lease_expires_at = NULL
       WHERE workspace_id = ? AND id = ? AND runner_id = ? AND status IN ('assigned','running')`,
      String(error ?? "").slice(0, 4000),
      code,
      Date.now(),
      wsId,
      jobId,
      runnerId,
    );
    if (changed === 0) return;
    const job = (await getJobRow(this.env.DB, wsId, jobId))!;
    await this.afterFailure(wsId, job);
    this.needsPump = true;
  }

  /** Mensagem de sistema na conversa + notificação ao responsável. */
  private async afterFailure(wsId: string, job: JobRow): Promise<void> {
    this.jobCache.delete(job.id);
    this.rejectedBy.delete(job.id);
    const ctx = this.domainCtx(wsId);
    const agent = await getAgentRow(this.env.DB, wsId, job.agent_id);
    const name = agent?.name ?? "O agente";
    const reason = (job.error ?? "erro desconhecido").slice(0, 300);
    if (job.channel_id) await postSystemMessage(ctx, job.channel_id, `${name} parou com um erro: ${reason}`, job.thread_root_id);
    if (agent) {
      await notify(ctx, {
        userId: agent.owner_user_id,
        kind: "job_failed",
        title: `${name} parou com um erro`,
        body: reason,
        link: job.channel_id ? links.channel(wsId, job.channel_id) : links.agent(wsId, agent.id),
      });
    }
    await publishJob(ctx, job);
  }

  /** Devolve o job à fila (attempts + 1) ou, ao atingir JOB_MAX_ATTEMPTS, marca `failed` com `runner_lost`. */
  private async requeueOrFail(wsId: string, job: JobRow, reason: string, cancelOnRunner = true): Promise<void> {
    const attempts = job.attempts + 1;
    const db = this.env.DB;
    const oldRunner = job.runner_id;
    let changed: number;
    if (attempts >= JOB_MAX_ATTEMPTS) {
      changed = await run(
        db,
        `UPDATE jobs SET status = 'failed', attempts = ?, error = ?, error_code = 'runner_lost', finished_at = ?, lease_expires_at = NULL
         WHERE workspace_id = ? AND id = ? AND runner_id IS ? AND status IN ('assigned','running')`,
        attempts,
        `${reason} Desisti depois de ${attempts} tentativas.`,
        Date.now(),
        wsId,
        job.id,
        oldRunner,
      );
    } else {
      changed = await run(
        db,
        `UPDATE jobs SET status = 'queued', attempts = ?, runner_id = NULL, runner_user_id = NULL, lease_expires_at = NULL
         WHERE workspace_id = ? AND id = ? AND runner_id IS ? AND status IN ('assigned','running')`,
        attempts,
        wsId,
        job.id,
        oldRunner,
      );
    }
    if (changed === 0) return;
    this.jobCache.delete(job.id);
    if (cancelOnRunner && oldRunner) this.sendToRunner(oldRunner, { type: "job.cancel", jobId: job.id });
    const updated = (await getJobRow(db, wsId, job.id))!;
    if (updated.status === "failed") await this.afterFailure(wsId, updated);
    else await publishJob(this.domainCtx(wsId), updated);
  }

  // ---------- Fila ----------
  /**
   * Entrega jobs `queued` a runners online, respeitando `capacity` do runner e `maxConcurrentJobs` do agente.
   * Ordem de candidatos: runner do job pai (origin agent) → runners de quem pediu → runners do responsável.
   * Se `preferredCli` do agente não existe num candidato, tenta o próximo.
   */
  private async doPump(wsId: string): Promise<void> {
    const db = this.env.DB;
    const queued = await all<JobRow>(
      db,
      "SELECT * FROM jobs WHERE workspace_id = ? AND status = 'queued' ORDER BY created_at LIMIT 100",
      wsId,
    );
    if (queued.length === 0) return;
    const runners = this.readyRunners();
    const runnerLoad = new Map<string, number>();
    const agentLoad = new Map<string, number>();
    const active = await all<{ runner_id: string | null; agent_id: string }>(
      db,
      "SELECT runner_id, agent_id FROM jobs WHERE workspace_id = ? AND status IN ('assigned','running')",
      wsId,
    );
    for (const a of active) {
      if (a.runner_id) runnerLoad.set(a.runner_id, (runnerLoad.get(a.runner_id) ?? 0) + 1);
      agentLoad.set(a.agent_id, (agentLoad.get(a.agent_id) ?? 0) + 1);
    }
    const agents = new Map<string, AgentRow | null>();
    const ctx = this.domainCtx(wsId);

    for (const job of queued) {
      if (!agents.has(job.agent_id)) agents.set(job.agent_id, await getAgentRow(db, wsId, job.agent_id));
      const agent = agents.get(job.agent_id);
      if (!agent) continue;

      const ordered: typeof runners = [];
      const push = (list: typeof runners) => {
        for (const r of list) if (!ordered.includes(r)) ordered.push(r);
      };
      let parentRunnerId: string | null = null;
      if (job.origin === "agent" && job.parent_job_id) {
        const parent = await first<{ runner_id: string | null; status: string }>(
          db,
          "SELECT runner_id, status FROM jobs WHERE workspace_id = ? AND id = ?",
          wsId,
          job.parent_job_id,
        );
        if (parent?.runner_id) push(runners.filter((r) => r.att.runnerId === parent.runner_id));
        if (parent?.runner_id && (parent.status === "assigned" || parent.status === "running")) parentRunnerId = parent.runner_id;
      }
      if (job.requested_by_user_id) push(runners.filter((r) => r.att.userId === job.requested_by_user_id));
      push(runners.filter((r) => r.att.userId === agent.owner_user_id));

      const rejected = this.rejectedBy.get(job.id);
      const eligible: typeof runners = [];
      for (const r of ordered) {
        if (agent.preferred_cli && !r.att.clis.includes(agent.preferred_cli)) continue;
        if (rejected?.has(r.att.runnerId)) continue;
        if (!(await this.runnerUserMayRun(wsId, job, agent, r.att.userId))) continue;
        eligible.push(r);
      }
      if (eligible.length === 0) {
        await this.setWaitingForRunner(ctx, job, true);
        await this.notifyNoRunner(ctx, job, agent);
        continue;
      }
      if (job.waiting_for_runner === 1) await this.setWaitingForRunner(ctx, job, false);
      if ((agentLoad.get(agent.id) ?? 0) >= agent.max_concurrent_jobs) continue;
      // Job filho vai ao runner do pai mesmo acima da capacidade (o pai está parado esperando por ele).
      const chosen = eligible.find(
        (r) => (runnerLoad.get(r.att.runnerId) ?? 0) < r.att.capacity + (r.att.runnerId === parentRunnerId ? CHILD_JOB_EXTRA_CAPACITY : 0),
      );
      if (!chosen) continue;

      const now = Date.now();
      const claimed = await run(
        db,
        `UPDATE jobs SET status = 'assigned', runner_id = ?, runner_user_id = ?, lease_expires_at = ?, waiting_for_runner = 0
         WHERE workspace_id = ? AND id = ? AND status = 'queued'`,
        chosen.att.runnerId,
        chosen.att.userId,
        now + JOB_LEASE_MS,
        wsId,
        job.id,
      );
      if (claimed === 0) continue;
      runnerLoad.set(chosen.att.runnerId, (runnerLoad.get(chosen.att.runnerId) ?? 0) + 1);
      agentLoad.set(agent.id, (agentLoad.get(agent.id) ?? 0) + 1);
      const assigned = (await getJobRow(db, wsId, job.id))!;
      try {
        const assignment = await buildAssignment(this.env, assigned, publicUrl(this.env, chosen.att.origin));
        chosen.ws.send(JSON.stringify({ type: "job.assign", assignment } satisfies HubToRunner));
      } catch (err) {
        console.error(JSON.stringify({ msg: "job.assign failed", jobId: job.id, error: String(err) }));
        await this.requeueOrFail(wsId, assigned, "Falha ao entregar o trabalho ao runner.", false);
        continue;
      }
      await publishJob(ctx, assigned);
    }
  }

  /**
   * O runner recebe o `JobAssignment` inteiro (pedido, contexto da conversa, memórias, instruções). Só entrega a
   * um runner cujo dono ainda é membro do workspace, pode falar com o agente e enxerga o canal do job.
   * (Segredos de conector têm regra própria em `buildAssignment`: só para o runner do dono do conector.)
   */
  private async runnerUserMayRun(wsId: string, job: JobRow, agent: AgentRow, userId: string): Promise<boolean> {
    const db = this.env.DB;
    if (!(await first(db, "SELECT 1 AS one FROM members WHERE workspace_id = ? AND user_id = ?", wsId, userId))) return false;
    if (!(await canTalkTo(db, agent, userId))) return false;
    if (job.channel_id) {
      const ch = await getChannel(db, wsId, job.channel_id);
      if (!ch || !(await canSeeChannel(db, ch, userId))) return false;
    }
    return true;
  }

  /** Mantém `jobs.waiting_for_runner` (JobDTO.waitingForRunner) e publica quando muda. */
  private async setWaitingForRunner(ctx: HubCtx, job: JobRow, waiting: boolean): Promise<void> {
    if ((job.waiting_for_runner === 1) === waiting) return;
    const changed = await run(
      this.env.DB,
      "UPDATE jobs SET waiting_for_runner = ? WHERE workspace_id = ? AND id = ? AND status = 'queued' AND waiting_for_runner = ?",
      waiting ? 1 : 0,
      ctx.wsId,
      job.id,
      waiting ? 0 : 1,
    );
    job.waiting_for_runner = waiting ? 1 : 0;
    if (changed > 0) await publishJob(ctx, job, { agentChanged: false });
  }

  private async notifyNoRunner(ctx: HubCtx, job: JobRow, agent: AgentRow): Promise<void> {
    if (job.no_runner_notified_at != null) return;
    const userId = job.requested_by_user_id ?? agent.owner_user_id;
    const claimed = await run(
      this.env.DB,
      "UPDATE jobs SET no_runner_notified_at = ? WHERE workspace_id = ? AND id = ? AND no_runner_notified_at IS NULL",
      Date.now(),
      ctx.wsId,
      job.id,
    );
    if (claimed === 0) return;
    await notify(ctx, {
      userId,
      kind: "no_runner",
      title: `${agent.name} está esperando um runner`,
      body: agent.preferred_cli
        ? `Nenhum runner online com ${agent.preferred_cli} pode executar este pedido agora. Ele roda assim que um conectar.`
        : "Nenhum runner online pode executar este pedido agora. Ele roda assim que um conectar.",
      link: job.channel_id ? links.channel(ctx.wsId, job.channel_id) : links.agent(ctx.wsId, agent.id),
    });
  }

  // ---------- Alarme ----------
  /**
   * Horários em que o alarme precisa acordar o DO. A segunda leva (rotinas) acrescenta aqui o
   * próximo `next_run_at` e trata o disparo em `alarm()`.
   */
  protected async alarmCandidates(wsId: string): Promise<number[]> {
    const lease = await first<{ t: number | null }>(
      this.env.DB,
      "SELECT MIN(lease_expires_at) AS t FROM jobs WHERE workspace_id = ? AND status IN ('assigned','running')",
      wsId,
    );
    // Rotinas: corrige linhas sem `next_run_at` e acorda no próximo disparo.
    await backfillRoutineSchedules(this.env.DB, wsId);
    const routine = await nextRoutineRunAt(this.env.DB, wsId);
    return [lease?.t, routine].filter((t): t is number => t != null);
  }

  private async scheduleAlarm(wsId: string): Promise<void> {
    const times = await this.alarmCandidates(wsId);
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.max(Date.now() + 50, Math.min(...times));
    const current = await this.ctx.storage.getAlarm();
    if (current !== next) await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    const wsId = await this.workspaceId();
    await this.serial(async () => {
      await this.expireLeases(wsId);
      await fireDueRoutines(this.domainCtx(wsId));
      this.needsPump = true;
    });
  }

  /** Jobs cuja posse venceu (sem heartbeat) voltam para a fila ou falham. */
  async expireLeases(wsId: string): Promise<void> {
    const expired = await all<JobRow>(
      this.env.DB,
      `SELECT * FROM jobs WHERE workspace_id = ? AND status IN ('assigned','running')
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      wsId,
      Date.now(),
    );
    for (const job of expired) await this.requeueOrFail(wsId, job, "O runner parou de responder.");
  }
}
