/**
 * Ambiente das avaliações: um hub de verdade (wrangler dev, com banco novo numa pasta temporária), um
 * runner de verdade ligado a ele e uma caixa de e-mail falsa como conector. O que é falso é só o serviço
 * externo e, no modo sem custo, o modelo. O resto é o caminho real: API, fila, checagem de permissão,
 * intermediário de conectores, memória.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentActionDTO, AgentDTO, ApprovalDTO, ConnectorDTO, JobDTO, MemoryDTO, MessageDTO, SetupPlanDTO, SetupSessionDTO, UsageEntryDTO } from "@puxibot/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..", "..");
const HUB_DIR = path.join(ROOT, "apps", "hub");
const RUNNER_CLI = path.join(ROOT, "apps", "runner", "src", "cli.ts");
const FIXTURES = path.resolve(HERE, "..", "fixtures");
const bin = (name: string) => path.join(ROOT, "node_modules", ".bin", name);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const c = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args.join(" ")} terminou com código ${code}\n${out.slice(-2000)}`))));
  });
}

function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export interface Mail {
  id: string;
  from: string;
  subject: string;
  body: string;
  read: boolean;
  deleted?: boolean;
}
export interface MailboxState {
  inbox: Mail[];
  sent: { to: string; subject: string; body: string; at: number }[];
}

/** Cliente HTTP mínimo do hub, com o cookie de sessão. */
export class Api {
  cookie = "";
  constructor(readonly base: string) {}

  async req<T = unknown>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(this.base + p, {
      method,
      headers: { Origin: this.base, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    const m = set && /tb_session=([^;]+)/.exec(set);
    if (m) this.cookie = `tb_session=${m[1]}`;
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  }
  async ok<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await this.req<T>(method, p, body);
    if (r.status >= 300) throw new Error(`${method} ${p} respondeu ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
    return r.body;
  }
}

export interface World {
  mode: "smoke" | "live";
  api: Api;
  wsId: string;
  base: string;
  userId: string;
  userName: string;
  /** Roteiro do agente roteirizado para o próximo trabalho (modo smoke). */
  setScript(script: Record<string, unknown>): void;
  readTrace(): { trace: { tool?: string; list?: boolean; tools?: string[]; isError?: boolean; text?: string }[] }[];
  seedMailbox(state: MailboxState): void;
  mailbox(): MailboxState;
  createAgent(name: string, instructions: string): Promise<AgentDTO>;
  /** Liga a caixa de e-mail falsa ao agente, com o nível dado. */
  connectMailbox(agent: AgentDTO, level: "read" | "write"): Promise<ConnectorDTO>;
  /** Manda a mensagem na DM com o agente e devolve o trabalho criado. */
  ask(agentId: string, text: string): Promise<{ jobId: string; channelId: string }>;
  waitJob(jobId: string, timeoutMs?: number): Promise<JobDTO>;
  /** Responde aprovações pendentes do agente conforme a política, até `stop()`. */
  autoApprove(agentId: string, policy: "approve" | "reject" | "ignore"): { stop(): Promise<ApprovalDTO[]> };
  actions(jobId: string): Promise<AgentActionDTO[]>;
  memories(agentId: string): Promise<{ agent: MemoryDTO[]; team: MemoryDTO[] }>;
  lastAgentMessage(channelId: string): Promise<string>;
  setupSession(): Promise<SetupSessionDTO>;
  setupPlan(): Promise<SetupPlanDTO | null>;
  stop(keep?: boolean): Promise<void>;
  dir: string;
}

export async function startWorld(opts: { mode: "smoke" | "live"; model?: string; verbose?: boolean; approvalWaitSeconds?: number }): Promise<World> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "puxibot-evals-"));
  const log = (msg: string) => opts.verbose && console.error(`[evals] ${msg}`);
  const persist = path.join(dir, "hub-state");
  const home = path.join(dir, "runner-home");
  mkdirSync(home, { recursive: true });

  // ---------- Hub ----------
  await run("node", [path.join(HUB_DIR, "scripts", "dev-setup.mjs")], { cwd: HUB_DIR });
  await run(bin("wrangler"), ["d1", "migrations", "apply", "puxibot", "--local", "--persist-to", persist], { cwd: HUB_DIR, env: { CI: "1" } });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hub = spawn(bin("wrangler"), ["dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--var", "OPEN_SIGNUP:true"], {
    cwd: HUB_DIR,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let hubLog = "";
  hub.stdout!.on("data", (d) => (hubLog = (hubLog + d).slice(-8000)));
  hub.stderr!.on("data", (d) => (hubLog = (hubLog + d).slice(-8000)));
  const api = new Api(base);
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/auth/signup-status`)).ok) break;
    } catch {
      /* ainda subindo */
    }
    if (hub.exitCode !== null || i > 240) {
      killTree(hub);
      throw new Error(`o hub não subiu:\n${hubLog}`);
    }
    await sleep(250);
  }
  log(`hub em ${base}`);

  // ---------- Conta e workspace ----------
  const userName = "Renata Lima";
  const me = await api.ok<{ user: { id: string } }>("POST", "/api/auth/signup", { email: `avaliacao-${Date.now()}@exemplo.com`, name: userName, password: "senha-de-avaliacao-123" });
  const ws = await api.ok<{ id: string }>("POST", "/api/workspaces", { name: "Avaliações", kind: "team" });
  const w = `/api/workspaces/${ws.id}`;
  const { token } = await api.ok<{ token: string }>("POST", `${w}/tokens`, { name: "runner das avaliações", kind: "runner" });

  // ---------- Runner ----------
  const scriptFile = path.join(home, "roteiro.json");
  const traceFile = path.join(home, "rastro.jsonl");
  writeFileSync(scriptFile, JSON.stringify({ steps: [], reply: "Pronto." }));
  const config: Record<string, unknown> = { capacity: 2, isolation: "none", approvals: { waitSeconds: opts.approvalWaitSeconds ?? 60 } };
  if (opts.mode === "smoke") {
    const wrapper = path.join(home, "claude-roteirizado");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(FIXTURES, "scripted-agent.mjs"))} --script ${JSON.stringify(scriptFile)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    config.cliPaths = { claude: wrapper };
    config.defaultCli = "claude";
  } else {
    config.defaultCli = "claude";
    config.models = { claude: opts.model ?? "haiku" };
  }
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config, null, 2));
  const runnerEnv = { ...process.env, PUXIBOT_HOME: home, FORCE_COLOR: "0" };
  await run(bin("tsx"), [RUNNER_CLI, "login", base, "--token", token, "--workspace", ws.id, "--name", "avaliacoes"], { cwd: ROOT, env: runnerEnv });
  const runner = spawn(bin("tsx"), [RUNNER_CLI, "start", "--isolation", "none", "--capacity", "2"], { cwd: ROOT, env: runnerEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let runnerLog = "";
  const onRunner = (d: Buffer) => {
    runnerLog = (runnerLog + d).slice(-12000);
    if (opts.verbose) process.stderr.write(`[runner] ${d}`);
  };
  runner.stdout!.on("data", onRunner);
  runner.stderr!.on("data", onRunner);
  for (let i = 0; ; i++) {
    const boot = await api.ok<{ runners: { online: boolean }[] }>("GET", `${w}/bootstrap`);
    if (boot.runners.some((r) => r.online)) break;
    if (runner.exitCode !== null || i > 120) {
      killTree(runner);
      killTree(hub);
      throw new Error(`o runner não conectou:\n${runnerLog}`);
    }
    await sleep(250);
  }
  log("runner conectado");

  const mailboxFile = path.join(dir, "caixa.json");
  const world: World = {
    mode: opts.mode,
    api,
    wsId: ws.id,
    base,
    userId: me.user.id,
    userName,
    dir,
    setScript: (script) => writeFileSync(scriptFile, JSON.stringify({ ...script, traceFile })),
    readTrace: () => {
      try {
        return readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    seedMailbox: (state) => writeFileSync(mailboxFile, JSON.stringify(state, null, 2)),
    mailbox: () => JSON.parse(readFileSync(mailboxFile, "utf8")) as MailboxState,
    createAgent: (name, instructions) =>
      api.ok<AgentDTO>("POST", `${w}/agents`, { handle: `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${Math.random().toString(36).slice(2, 7)}`, name, role: "Assistente", instructions }),
    async connectMailbox(agent, level) {
      const conn = await api.ok<ConnectorDTO>("POST", `${w}/connectors`, {
        name: "E-mail",
        transport: "stdio",
        command: process.execPath,
        args: [path.join(FIXTURES, "mailbox.mjs")],
        env: { MAILBOX_STATE: mailboxFile },
      });
      await api.ok("PATCH", `${w}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: level } });
      return conn;
    },
    async ask(agentId, text) {
      const dm = await api.ok<{ id: string }>("POST", `${w}/dms`, { with: { type: "agent", id: agentId } });
      const before = new Set((await api.ok<{ items: JobDTO[] }>("GET", `${w}/jobs?agentId=${agentId}`)).items.map((j) => j.id));
      await api.ok("POST", `${w}/channels/${dm.id}/messages`, { body: text });
      for (let i = 0; i < 80; i++) {
        const job = (await api.ok<{ items: JobDTO[] }>("GET", `${w}/jobs?agentId=${agentId}`)).items.find((j) => !before.has(j.id));
        if (job) return { jobId: job.id, channelId: dm.id };
        await sleep(250);
      }
      throw new Error("o hub não criou um trabalho para a mensagem");
    },
    async waitJob(jobId, timeoutMs = 5 * 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const all = (await api.ok<{ items: JobDTO[] }>("GET", `${w}/jobs`)).items;
        const job = all.find((j) => j.id === jobId);
        if (job && ["done", "failed", "cancelled"].includes(job.status)) return job;
        if (Date.now() > deadline) throw new Error(`o trabalho não terminou em ${Math.round(timeoutMs / 1000)} s (status: ${job?.status ?? "?"})`);
        await sleep(500);
      }
    },
    autoApprove(agentId, policy) {
      const seen: ApprovalDTO[] = [];
      let running = true;
      const loop = (async () => {
        while (running) {
          const pending = (await api.ok<{ items: ApprovalDTO[] }>("GET", `${w}/approvals?status=pending`)).items.filter((a) => a.agentId === agentId);
          for (const a of pending) {
            if (seen.some((s) => s.id === a.id)) continue;
            seen.push(a);
            if (policy !== "ignore") await api.req("POST", `${w}/approvals/${a.id}/decide`, { decision: policy === "approve" ? "approved" : "rejected", ...(policy === "reject" ? { note: "não autorizado pela avaliação" } : {}) });
          }
          await sleep(300);
        }
      })();
      return {
        async stop() {
          running = false;
          await loop;
          return seen;
        },
      };
    },
    async actions(jobId) {
      const items = (await api.ok<{ items: UsageEntryDTO[] }>("GET", `${w}/usage?limit=200`)).items;
      return items.find((e) => e.jobId === jobId)?.actions ?? [];
    },
    async memories(agentId) {
      const agent = (await api.ok<{ items: MemoryDTO[] }>("GET", `${w}/agents/${agentId}/memories`)).items;
      const team = (await api.ok<{ items: MemoryDTO[] }>("GET", `${w}/memories`)).items;
      return { agent, team };
    },
    async lastAgentMessage(channelId) {
      const items = (await api.ok<{ items: MessageDTO[] }>("GET", `${w}/channels/${channelId}/messages`)).items;
      return items.filter((m) => m.author.type === "agent").at(-1)?.body ?? "";
    },
    setupSession: () => api.ok<SetupSessionDTO>("POST", `${w}/setup/session`),
    setupPlan: async () => (await api.ok<{ plan: SetupPlanDTO | null }>("GET", `${w}/setup/plan`)).plan,
    async stop(keep = false) {
      const gone = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once("close", () => r())));
      killTree(runner);
      // O runner encerra a CLI e a revisão de memória em andamento antes de sair.
      await Promise.race([gone(runner), sleep(10_000)]);
      killTree(hub);
      await Promise.race([gone(hub), sleep(5_000)]);
      if (keep) return;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (e) {
        console.error(`  (não consegui apagar ${dir}: ${e instanceof Error ? e.message : String(e)})`);
      }
    },
  };
  return world;
}
