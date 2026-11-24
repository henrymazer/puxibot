/**
 * Execução de jobs: aceitar/rejeitar, heartbeat, streaming, cancelamento,
 * tempo limite e resultado.
 */
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_TOOL,
  CHILD_JOB_EXTRA_CAPACITY,
  JOB_HEARTBEAT_MS,
  type Cli,
  type IsolationMode,
  type JobAssignment,
  type JobErrorCode,
  type RunnerToHub,
} from "@puxibot/shared";
import { ADAPTERS, CLI_ORDER, binPathFor } from "./adapters/index.js";
import type { AdapterResult, CliAdapter, CliStatus } from "./adapters/types.js";
import { paths, SessionStore, type RunnerConfig } from "./config.js";
import { filterConnectorEnv, type RunnerConnector } from "./adapters/types.js";
import { ensureImage, hostExecutable, isLocalUrl, isolate, rejectedExecutables, type IsolationStatus } from "./isolation.js";
import type { Logger } from "./log.js";
import { buildMemoryReviewPrompt, fetchCurrentMemories, parseMemoryReview, sendLearnedSkill, sendMemoryReview, shouldLearnSkill } from "./memory.js";
import { childEnv, cleanEnv, spawnGroup, type RunningProcess } from "./proc.js";
import { buildSystemPrompt, buildUserPrompt, ensureAgentDir, writeSkills } from "./prompt.js";
import { selfCommand, selfCommandInContainer } from "./self.js";

export interface JobManagerOptions {
  /** Envia ao hub. A conexão guarda mensagens importantes enquanto estiver fora do ar. */
  send(msg: RunnerToHub): void;
  capacity: number;
  isolation: IsolationMode;
  isolationStatus?: IsolationStatus;
  config: RunnerConfig;
  clis: CliStatus[];
  logger: Logger;
  adapters?: Record<Cli, CliAdapter>;
  sessions?: SessionStore;
  /** Intervalo mínimo entre `job.stream` (padrão 250 ms, ~4 por segundo). */
  streamIntervalMs?: number;
  heartbeatMs?: number;
}

interface ActiveJob {
  assignment: JobAssignment;
  cli: Cli;
  model: string | null;
  proc: RunningProcess | null;
  cancelled: boolean;
  timedOut: boolean;
  returned: boolean;
  heartbeat: NodeJS.Timeout;
  done: Promise<void>;
  /** Ferramentas usadas no trabalho (resumos), para o procedimento aprendido. */
  toolEvents: string[];
}

export class JobManager {
  private readonly jobs = new Map<string, ActiveJob>();
  /** Execuções ainda em limpeza (já liberadas da capacidade, mas não terminadas). */
  private readonly inflight = new Set<Promise<void>>();
  private shuttingDown = false;
  private readonly adapters: Record<Cli, CliAdapter>;
  private readonly sessions: SessionStore;
  private readonly streamMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly opts: JobManagerOptions) {
    this.adapters = opts.adapters ?? ADAPTERS;
    this.sessions = opts.sessions ?? new SessionStore();
    this.streamMs = opts.streamIntervalMs ?? 250;
    this.heartbeatMs = opts.heartbeatMs ?? JOB_HEARTBEAT_MS;
  }

  get running(): number {
    return this.jobs.size;
  }

  runningJobIds(): string[] {
    return [...this.jobs.keys()];
  }

  setClis(clis: CliStatus[]): void {
    this.opts.clis = clis;
  }

  /** CLIs utilizáveis: instaladas e sem login reconhecidamente ausente. */
  availableClis(): Cli[] {
    return CLI_ORDER.filter((c) => this.opts.clis.some((s) => s.cli === c && s.installed && s.loggedIn !== false));
  }

  chooseCli(a: JobAssignment): { cli: Cli } | { reason: string } {
    const available = this.availableClis();
    const pref = a.agent.preferredCli;
    if (pref) {
      if (available.includes(pref)) return { cli: pref };
      const st = this.opts.clis.find((s) => s.cli === pref);
      const why = !st?.installed ? "não está instalada" : "não está logada";
      return { reason: `a CLI preferida do agente (${pref}) ${why} neste runner` };
    }
    const def = this.opts.config.defaultCli;
    if (def && available.includes(def)) return { cli: def };
    const first = available[0];
    if (first) return { cli: first };
    return { reason: "nenhuma CLI de IA instalada e logada neste runner" };
  }

  handleAssign(a: JobAssignment): void {
    const log = this.opts.logger;
    const existing = this.jobs.get(a.jobId);
    if (existing) {
      // Reentrega após reconexão: o job continua aqui; confirma de novo.
      this.opts.send({ type: "job.accepted", jobId: a.jobId, cli: existing.cli, model: existing.model });
      return;
    }
    if (this.shuttingDown) {
      this.opts.send({ type: "job.rejected", jobId: a.jobId, reason: "runner encerrando" });
      return;
    }
    if (this.jobs.size >= this.opts.capacity && !this.childOverflowAllowed(a)) {
      this.opts.send({ type: "job.rejected", jobId: a.jobId, reason: `runner sem capacidade (${this.jobs.size}/${this.opts.capacity} jobs)` });
      return;
    }
    const choice = this.chooseCli(a);
    if ("reason" in choice) {
      log.warn(`job ${a.jobId} recusado: ${choice.reason}`);
      this.opts.send({ type: "job.rejected", jobId: a.jobId, reason: choice.reason });
      return;
    }
    const cli = choice.cli;
    const model = a.agent.preferredModel ?? this.opts.config.models?.[cli] ?? null;
    const job: ActiveJob = {
      assignment: a,
      cli,
      model,
      proc: null,
      cancelled: false,
      timedOut: false,
      returned: false,
      heartbeat: setInterval(() => this.opts.send({ type: "job.heartbeat", jobId: a.jobId }), this.heartbeatMs),
      done: Promise.resolve(),
      toolEvents: [],
    };
    this.jobs.set(a.jobId, job);
    this.opts.send({ type: "job.accepted", jobId: a.jobId, cli, model });
    log.info(`job ${a.jobId}: @${a.agent.handle} via ${cli}${model ? ` (${model})` : ""}, isolamento ${this.opts.isolation}`);
    job.done = this.execute(job)
      .catch((e: unknown) => {
        if (job.cancelled || job.returned) return;
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`job ${a.jobId} falhou: ${msg}`);
        this.release(job);
        this.opts.send({ type: "job.failed", jobId: a.jobId, errorCode: "error", error: msg.slice(0, 2000) });
      })
      .finally(() => this.release(job));
    this.inflight.add(job.done);
    void job.done.finally(() => this.inflight.delete(job.done));
  }

  /**
   * Job filho (consulta entre agentes) cujo pai roda aqui: o pai está parado esperando a
   * resposta, então o filho entra mesmo acima da capacidade — no máximo
   * CHILD_JOB_EXTRA_CAPACITY jobs a mais (o que também limita a profundidade da cadeia).
   */
  private childOverflowAllowed(a: JobAssignment): boolean {
    if (a.origin !== "agent" || !a.parentJobId) return false;
    const parent = this.jobs.get(a.parentJobId);
    if (!parent || parent.cancelled || parent.returned || parent.timedOut) return false;
    if (this.jobs.size - this.opts.capacity >= CHILD_JOB_EXTRA_CAPACITY) return false;
    this.opts.logger.info(`job ${a.jobId}: consulta do job ${a.parentJobId} (em execução aqui); aceito acima da capacidade`);
    return true;
  }

  handleCancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.opts.logger.info(`job ${jobId}: cancelado pelo hub`);
    job.cancelled = true;
    void job.proc?.kill();
  }

  /** Após reconectar: renova a posse de tudo que está rodando. */
  resendHeartbeats(): void {
    for (const id of this.jobs.keys()) this.opts.send({ type: "job.heartbeat", jobId: id });
  }

  /** Encerramento limpo: mata os processos e devolve os jobs ao hub. */
  async shutdown(reason = "runner encerrado pela pessoa"): Promise<void> {
    this.shuttingDown = true;
    const all = [...this.jobs.values()];
    for (const job of all) {
      job.returned = true;
      this.opts.send({ type: "job.rejected", jobId: job.assignment.jobId, reason: `runner_shutdown: ${reason}` });
      void job.proc?.kill(2000);
    }
    await Promise.race([Promise.all([...this.inflight]), new Promise((r) => setTimeout(r, 8000))]);
  }

  /** Espera todos os jobs em andamento (testes). */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  /**
   * Endereço do hub usado pelo job: sempre o do config.json local. O que vem no job (do hub)
   * é ignorado se for diferente, para o hub não decidir a rede do container nem para onde o
   * token do job vai.
   */
  private hubUrlFor(a: JobAssignment): string {
    const local = this.opts.config.hubUrl;
    if (!local) return a.hubUrl;
    if (a.hubUrl && a.hubUrl.replace(/\/+$/, "") !== local.replace(/\/+$/, "")) {
      this.opts.logger.warn(`job ${a.jobId}: o hub mandou outro endereço (${a.hubUrl}); usando o configurado (${local})`);
    }
    return local;
  }

  /**
   * Conectores do job, já filtrados: variáveis perigosas saem do ambiente do conector e, no
   * sandbox, conector stdio cujo comando está numa pasta escondida fica de fora.
   */
  private prepareConnectors(job: ActiveJob, binPath: string, pathEnv: string, workdir: string): RunnerConnector[] {
    const a = job.assignment;
    const out: RunnerConnector[] = [];
    // O intermediário de cada conector consulta o hub (checagem de permissão e registro das ações).
    const hub = { url: this.hubUrlFor(a), token: a.jobToken };
    const waitSeconds = this.opts.config.approvals?.waitSeconds;
    const approvalWaitMs = typeof waitSeconds === "number" && waitSeconds > 0 ? Math.min(waitSeconds, 25 * 60) * 1000 : undefined;
    const warn = (summary: string) => {
      this.opts.logger.warn(`job ${a.jobId}: ${summary}`);
      this.opts.send({ type: "job.event", jobId: a.jobId, kind: "status", summary: summary.slice(0, 300) });
    };
    const mode = this.opts.isolation;
    for (const c of a.connectors) {
      const { env, dropped } = filterConnectorEnv(c.env);
      if (dropped.length) warn(`conector ${c.name}: variáveis ignoradas por segurança: ${dropped.join(", ")}`);
      const conn: RunnerConnector = { ...c, env, hub, ...(approvalWaitMs ? { approvalWaitMs } : {}) };
      if (mode === "sandbox" && c.level !== "none" && c.transport === "stdio" && c.command) {
        const rej = rejectedExecutables(
          { mode, jobId: a.jobId, command: binPath, args: [], env: { PATH: pathEnv }, workdir: paths.agentDir(a.workspace.id, a.agent.id), writable: [], readable: [], credentials: [], executables: [c.command] },
          this.opts.config,
        );
        if (rej.length) {
          warn(
            `conector ${c.name} desligado neste trabalho: o comando ${rej[0]!.path} fica numa pasta escondida do sandbox. ` +
              "Para usá-lo, libere a pasta em sandbox.extraReadOnly no config.json do runner.",
          );
          continue;
        }
      }
      out.push(conn);
    }
    const browser = this.browserConnector(a, hub, workdir, warn);
    if (browser) out.push({ ...browser, ...(approvalWaitMs ? { approvalWaitMs } : {}) });
    return out;
  }

  /**
   * Navegador do agente: um servidor MCP do Playwright atrás do mesmo intermediário dos conectores.
   * Só entra quando o agente tem o navegador ligado e quando a pessoa dona deste computador o ligou
   * no config.json (`"browser": { "enabled": true }`).
   */
  private browserConnector(a: JobAssignment, hub: { url: string; token: string }, workdir: string, warn: (summary: string) => void): RunnerConnector | null {
    if ((a.agent.toolPerms[BROWSER_TOOL] ?? "none") === "none") return null;
    const cfg = this.opts.config.browser;
    if (!cfg?.enabled) {
      warn('navegador desligado neste computador: ligue com "browser": { "enabled": true } no config.json do runner');
      return null;
    }
    if (this.opts.isolation === "container" && !cfg.command) {
      warn("navegador indisponível no modo container (a imagem padrão não tem navegador); use o modo sandbox ou defina browser.command");
      return null;
    }
    // Dentro do isolamento do runner o sandbox próprio do Chromium não sobe; o isolamento é o do runner.
    const args = cfg.args ?? ["-y", "@playwright/mcp@latest", "--headless", "--isolated", ...(this.opts.isolation === "none" ? [] : ["--no-sandbox"])];
    return {
      id: BROWSER_TOOL,
      name: "Navegador",
      transport: "stdio",
      url: null,
      command: cfg.command ?? "npx",
      args,
      headers: {},
      // O cache do npx fica na pasta do agente: a do seu usuário continua escondida no isolamento.
      env: { npm_config_cache: path.join(workdir, ".cache", "npm") },
      level: "write",
      hub,
      vault: a.vault ?? [],
    };
  }

  // ---------- execução ----------
  private async execute(job: ActiveJob): Promise<void> {
    const a = job.assignment;
    const log = this.opts.logger;
    const adapter = this.adapters[job.cli];
    const workdir = await ensureAgentDir(a);
    const runDir = paths.runDir(a.jobId);
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    const timer = setTimeout(() => {
      job.timedOut = true;
      log.warn(`job ${a.jobId}: tempo limite de ${Math.round(a.timeoutMs / 1000)} s`);
      void job.proc?.kill();
    }, a.timeoutMs);

    try {
      const skills = await writeSkills(workdir, adapter.skillsDir, a.agent.skills);
      const session = this.sessions.get(a.sessionKey, job.cli);
      let result = await this.runOnce(job, adapter, workdir, runDir, skills, session?.sessionId ?? null, session?.updatedAt ?? null);
      if (result && !result.ok && result.resumeFailed && session && !job.cancelled && !job.timedOut && !job.returned) {
        log.warn(`job ${a.jobId}: sessão ${session.sessionId} não existe mais; começando uma nova`);
        this.sessions.delete(a.sessionKey);
        result = await this.runOnce(job, adapter, workdir, runDir, skills, null, null);
      }
      if (job.returned) return;
      if (job.cancelled) {
        log.info(`job ${a.jobId}: processo encerrado após cancelamento`);
        return;
      }
      if (job.timedOut) {
        this.fail(job, "timeout", `o agente passou do tempo limite (${Math.round(a.timeoutMs / 60_000) || 1} min)`);
        return;
      }
      if (!result) return;
      if (!result.ok) {
        const code = result.errorCode ?? "error";
        this.fail(job, code, friendlyError(code, job.cli, result.error));
        return;
      }
      if (result.sessionId) this.sessions.set(a.sessionKey, { cli: job.cli, sessionId: result.sessionId, updatedAt: Date.now() });
      this.release(job);
      this.opts.send({
        type: "job.done",
        jobId: a.jobId,
        text: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model ?? job.model,
      });
      log.info(`job ${a.jobId}: concluído (${result.inputTokens} tokens de entrada, ${result.outputTokens} de saída, ${result.model ?? "?"})`);
      // Depois da resposta entregue (para não atrasá-la): revisão da memória do agente.
      await this.reviewMemory(job, adapter, workdir, runDir, skills, result.text).catch((e: unknown) =>
        log.warn(`job ${a.jobId}: revisão de memória falhou: ${String(e instanceof Error ? e.message : e)}`),
      );
    } finally {
      clearTimeout(timer);
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Revisão automática de memória (memory.ts): uma chamada curta, sem ferramentas, à mesma CLI.
   * Só roda se o agente pode escrever memória, se a CLI tem esse modo e se a pessoa não desligou
   * (`"memory": { "auto": false }` no config.json).
   */
  private async reviewMemory(job: ActiveJob, adapter: CliAdapter, workdir: string, runDir: string, skills: string[], resultText: string): Promise<void> {
    const a = job.assignment;
    const cfg = this.opts.config.memory;
    const learnSkill = this.opts.config.skills?.learn !== false && shouldLearnSkill(a, job.toolEvents);
    const reviewMemory = cfg?.auto !== false && a.agent.toolPerms.memory === "write";
    if ((!reviewMemory && !learnSkill) || !adapter.utilityModel || !resultText.trim()) return;
    const hubUrl = this.hubUrlFor(a);
    // A lista do trabalho é de antes de ele rodar; o agente pode tê-la mudado no caminho.
    const memories = await fetchCurrentMemories(a, hubUrl).catch((e: unknown) => {
      this.opts.logger.debug(`job ${a.jobId}: usando as memórias do início do trabalho (${String(e)})`);
      return a.memories;
    });
    const prompt = buildMemoryReviewPrompt({ ...a, memories: reviewMemory ? memories : [] }, resultText, { learnSkill, toolEvents: job.toolEvents });
    const result = await this.runOnce(job, adapter, workdir, runDir, skills, null, null, {
      system: prompt.system,
      user: prompt.user,
      model: cfg?.model ?? adapter.utilityModel,
    });
    if (!result?.ok) {
      if (result) this.opts.logger.debug(`job ${a.jobId}: revisão de memória sem resultado: ${result.error ?? result.errorCode ?? ""}`);
      return;
    }
    const review = parseMemoryReview(result.text, prompt.aliases);
    const usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    // Mesmo sem mudanças, o hub recebe o custo da revisão para somar ao trabalho.
    const r = reviewMemory ? await sendMemoryReview(a, hubUrl, review, usage) : await sendMemoryReview(a, hubUrl, { add: [], remove: [] }, usage);
    if (r.added || r.removed) this.opts.logger.info(`job ${a.jobId}: memória revisada (+${r.added}, −${r.removed})`);
    if (learnSkill && review.skill && (await sendLearnedSkill(a, hubUrl, review.skill))) {
      this.opts.logger.info(`job ${a.jobId}: procedimento aprendido ("${review.skill.name}")`);
    }
  }

  /** Libera a vaga antes da mensagem final: o hub pode mandar o próximo job logo em seguida. */
  private release(job: ActiveJob): void {
    clearInterval(job.heartbeat);
    if (this.jobs.get(job.assignment.jobId) === job) this.jobs.delete(job.assignment.jobId);
  }

  private fail(job: ActiveJob, errorCode: JobErrorCode, error: string): void {
    this.opts.logger.warn(`job ${job.assignment.jobId}: falhou (${errorCode}): ${error}`);
    this.release(job);
    this.opts.send({ type: "job.failed", jobId: job.assignment.jobId, errorCode, error: error.slice(0, 2000) });
  }

  private async runOnce(
    job: ActiveJob,
    adapter: CliAdapter,
    workdir: string,
    runDir: string,
    skills: string[],
    resumeSessionId: string | null,
    contextSince: number | null,
    /** Chamada utilitária (revisão de memória): sem ferramentas, sem conectores e sem nada na conversa. */
    utility?: { system: string; user: string; model: string | null },
  ): Promise<AdapterResult | null> {
    const log = this.opts.logger;
    const mode = this.opts.isolation;
    const binPath = binPathFor(job.cli, this.opts.config);
    // Sem isolamento, a CLI roda como a pessoa e recebe o ambiente do terminal (só sem as
    // variáveis de sessão). Isolada, recebe só uma lista curta (proc.ts), mais o que o
    // adaptador declara e o que a pessoa liberou em `env.pass`.
    const baseEnv = mode === "none" ? cleanEnv() : childEnv({ pass: this.opts.config.env?.pass, extra: adapter.authEnv });
    const connectors = utility ? [] : this.prepareConnectors(job, binPath, baseEnv.PATH ?? process.env.PATH ?? "", workdir);
    const a: JobAssignment = { ...job.assignment, connectors };
    const hubUrl = this.hubUrlFor(a);
    const mcp = mode === "container" ? selfCommandInContainer() : selfCommand();
    const mcpEnv: Record<string, string> = {
      PUXIBOT_HUB_URL: hubUrl,
      PUXIBOT_JOB_TOKEN: a.jobToken,
      PUXIBOT_TOOL_PERMS: JSON.stringify(a.agent.toolPerms),
      PUXIBOT_AGENT_IS_ASSISTANT: a.agent.isAssistant ? "1" : "0",
      PUXIBOT_AGENT_KIND: a.agent.systemKind ?? "",
      PUXIBOT_CHANNEL_ID: a.channel?.id ?? "",
    };
    const prepared = await adapter.prepare({
      assignment: a,
      workdir,
      runDir,
      systemPrompt: utility ? utility.system : buildSystemPrompt(a, workdir, skills, adapter.skillsDir),
      userPrompt: utility ? utility.user : buildUserPrompt(a, { contextSince: resumeSessionId ? contextSince : null }),
      model: utility ? utility.model : job.model,
      resumeSessionId,
      utility: !!utility,
      isolation: mode,
      mcp: { command: mcp.command, args: [...mcp.args, "mcp"] },
      mcpProxy: { command: mcp.command, args: [...mcp.args, "mcp-proxy"] },
      mcpExec: { command: mcp.command, args: [...mcp.args, "mcp-exec"] },
      mcpEnv,
      baseEnv,
      binPath,
    });
    if (job.cancelled || job.returned || job.timedOut) return null;

    let image: string | undefined;
    if (mode === "container") {
      const rt = this.opts.isolationStatus?.container.runtime;
      if (!rt) throw new Error("modo container indisponível neste runner");
      if (!this.opts.config.container?.image) {
        if (!utility) this.opts.send({ type: "job.event", jobId: a.jobId, kind: "status", summary: "preparando o container" });
        image = await ensureImage(this.opts.isolationStatus?.container.path ?? hostExecutable(rt), adapter.npmPackage, log);
      }
    }
    const cmd = await isolate(
      {
        mode,
        jobId: utility ? `${a.jobId}-mem` : a.jobId,
        command: prepared.command,
        args: prepared.args,
        env: prepared.env,
        workdir,
        writable: prepared.writable,
        // Navegadores que a pessoa instalou com `npx playwright install` ficam na pasta pessoal.
        readable: connectors.some((c) => c.id === BROWSER_TOOL) ? [...prepared.readable, ...playwrightBrowserDirs()] : prepared.readable,
        credentials: prepared.credentials,
        // Comandos de conectores stdio também precisam existir dentro do sandbox.
        executables: a.connectors.filter((c) => c.level !== "none" && c.transport === "stdio" && c.command).map((c) => c.command!),
        image,
        hubIsLocal: isLocalUrl(hubUrl),
      },
      this.opts.config,
      log,
      this.opts.isolationStatus,
    );
    if (job.cancelled || job.returned || job.timedOut) return null;
    for (const c of prepared.credentials) {
      log.debug(`job ${a.jobId}: credencial ${c.path} ${c.writable ? `com escrita (${c.reason ?? ""})` : "somente leitura"}`);
    }

    const parser = adapter.createParser({ model: utility ? utility.model : job.model });
    let text = "";
    let lastSent = "";
    let lastSentAt = 0;
    let pending: NodeJS.Timeout | null = null;
    const flush = () => {
      pending = null;
      if (utility || text === lastSent || job.cancelled || job.returned) return;
      lastSent = text;
      lastSentAt = Date.now();
      this.opts.send({ type: "job.stream", jobId: a.jobId, text });
    };
    let stderr = "";
    const proc = spawnGroup(
      { command: cmd.command, args: cmd.args, env: cmd.env, cwd: cmd.cwd, stdin: prepared.stdin },
      (line) => {
        for (const ev of parser.line(line)) {
          if (ev.type === "text") {
            text += ev.delta;
            const wait = this.streamMs - (Date.now() - lastSentAt);
            if (wait <= 0) flush();
            else if (!pending) pending = setTimeout(flush, wait);
          } else if (utility) {
            // chamada utilitária: nada vai para a conversa
          } else if (ev.type === "tool") {
            if (job.toolEvents.length < 200) job.toolEvents.push(ev.summary.slice(0, 300));
            this.opts.send({ type: "job.event", jobId: a.jobId, kind: "tool", summary: ev.summary.slice(0, 300) });
          } else if (ev.type === "model") {
            job.model = ev.model;
          }
        }
      },
      (chunk) => {
        stderr = (stderr + chunk).slice(-20_000);
      },
      cmd.kill,
    );
    job.proc = proc;
    if (job.cancelled || job.timedOut || job.returned) void proc.kill();
    const exit = await proc.exited;
    if (pending) clearTimeout(pending);
    job.proc = null;
    await prepared.afterRun?.().catch((e: unknown) => log.warn(`pós-execução da CLI falhou: ${String(e)}`));
    if (stderr.trim()) log.debug(`job ${a.jobId} stderr: ${stderr.trim().slice(-2000)}`);
    if (job.cancelled || job.returned || job.timedOut) return null;
    return parser.finish(exit, stderr);
  }
}

/** Onde o Playwright guarda os navegadores baixados (Linux e macOS). */
export function playwrightBrowserDirs(): string[] {
  const custom = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const dirs = custom ? [custom] : [path.join(os.homedir(), ".cache", "ms-playwright"), path.join(os.homedir(), "Library", "Caches", "ms-playwright")];
  return dirs.filter((d) => existsSync(d));
}

const CLI_NAMES: Record<Cli, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

function friendlyError(code: JobErrorCode, cli: Cli, detail?: string): string {
  const name = CLI_NAMES[cli];
  const d = detail ? ` Detalhe: ${detail}` : "";
  switch (code) {
    case "auth":
      return `O login do ${name} na máquina do runner falhou ou expirou. Quem executa o runner precisa entrar de novo na CLI.${d}`;
    case "limit":
      return `O plano do ${name} de quem executa o runner chegou ao limite de uso.${d}`;
    default:
      return detail ?? `o ${name} falhou`;
  }
}
