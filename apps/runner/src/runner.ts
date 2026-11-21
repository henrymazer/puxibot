/** `puxibot start`: liga conexão + jobs e cuida do encerramento limpo. */
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import { RUNNER_PROTOCOL_VERSION, type IsolationMode } from "@puxibot/shared";
import { detectClis } from "./adapters/index.js";
import { ensureHome, loadConfig, loadToken, paths, updateConfig, type RunnerConfig } from "./config.js";
import { HubConnection } from "./connection.js";
import { detectIsolation, isolationWarning } from "./isolation.js";
import { JobManager } from "./jobs.js";
import { createLogger, type Logger } from "./log.js";

export interface StartOptions {
  isolation?: IsolationMode;
  capacity?: number;
  name?: string;
  logger?: Logger;
  /** Não instala tratadores de sinal (testes). */
  noSignals?: boolean;
}

export interface RunningRunner {
  connection: HubConnection;
  jobs: JobManager;
  stop(reason?: string): Promise<void>;
}

export function runnerPlatform(): string {
  let p = `${process.platform}-${process.arch}`;
  if (process.platform === "linux") {
    try {
      if (/microsoft/i.test(readFileSync("/proc/version", "utf8"))) p += " (WSL2)";
    } catch {
      /* ignora */
    }
  }
  return p;
}

export async function startRunner(opts: StartOptions = {}): Promise<RunningRunner> {
  const log = opts.logger ?? createLogger("puxibot");
  const cfg: RunnerConfig = loadConfig();
  const token = loadToken();
  if (!cfg.hubUrl || !cfg.workspaceId || !token) {
    throw new Error("runner não está conectado a um hub. Rode `puxibot login <url-do-hub>` primeiro.");
  }
  const name = opts.name ?? cfg.name ?? os.hostname();
  const capacity = Math.max(1, opts.capacity ?? cfg.capacity ?? 1);

  const [clis, iso] = await Promise.all([detectClis(cfg), detectIsolation(cfg)]);
  let isolation: IsolationMode = opts.isolation ?? cfg.isolation ?? "sandbox";
  if (isolation === "sandbox" && !iso.sandbox.available) {
    throw new Error(`isolamento sandbox indisponível: ${iso.sandbox.detail}. Use --isolation container ou --isolation none.`);
  }
  if (isolation === "container" && !iso.container.available) {
    throw new Error(`isolamento container indisponível: ${iso.container.detail}.`);
  }
  const warn = isolationWarning(isolation);
  if (warn) log.warn(warn);

  for (const c of clis) {
    if (!c.installed) continue;
    log.info(`${c.cli} ${c.version ?? "?"}: ${c.loggedIn === false ? "NÃO logado" : c.loggedIn ? "logado" : "login desconhecido"}`);
  }

  ensureHome();
  await fs.writeFile(paths.pid(), String(process.pid), { mode: 0o600 });

  let runnerId = cfg.runnerId ?? null;
  // eslint-disable-next-line prefer-const
  let jobs: JobManager;
  const connection = new HubConnection({
    hubUrl: cfg.hubUrl,
    workspaceId: cfg.workspaceId,
    token,
    logger: log,
    hello: () => ({
      type: "hello",
      protocol: RUNNER_PROTOCOL_VERSION,
      runnerId,
      name,
      platform: runnerPlatform(),
      clis: clis.filter((c) => c.installed).map((c) => ({ cli: c.cli, version: c.version, loggedIn: c.loggedIn })),
      isolation,
      capacity,
    }),
    onWelcome: (msg) => {
      if (msg.runnerId !== runnerId) {
        runnerId = msg.runnerId;
        updateConfig({ runnerId });
      }
      jobs.resendHeartbeats();
    },
    onMessage: (msg) => {
      if (msg.type === "job.assign") jobs.handleAssign(msg.assignment);
      else if (msg.type === "job.cancel") jobs.handleCancel(msg.jobId);
    },
    onFatal: () => {
      void stop("token recusado").then(() => {
        if (!opts.noSignals) process.exit(2);
      });
    },
  });
  jobs = new JobManager({
    send: (m) => connection.send(m),
    capacity,
    isolation,
    isolationStatus: iso,
    config: cfg,
    clis,
    logger: log,
  });

  let stopping: Promise<void> | null = null;
  const stop = (reason = "runner encerrado pela pessoa"): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (jobs.running) log.info(`devolvendo ${jobs.running} job(s) em andamento ao hub...`);
      await jobs.shutdown(reason);
      await connection.flush();
      await connection.stop();
      await fs.rm(paths.pid(), { force: true }).catch(() => {});
    })();
    return stopping;
  };

  if (!opts.noSignals) {
    let count = 0;
    const onSignal = (sig: NodeJS.Signals) => {
      count++;
      if (count > 1) {
        log.warn("saindo sem esperar");
        process.exit(130);
      }
      log.info(`${sig} recebido; encerrando (Ctrl+C de novo para sair na hora)`);
      void stop().then(() => process.exit(0));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  log.info(`runner "${name}" conectando a ${cfg.hubUrl} (workspace ${cfg.workspaceId}, isolamento ${isolation}, capacidade ${capacity})`);
  connection.start();
  return { connection, jobs, stop };
}
