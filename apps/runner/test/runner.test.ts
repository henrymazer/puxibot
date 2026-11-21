import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isAlive, setupTestEnv, until } from "./helpers/env.js";
import { FakeHub, makeAssignment } from "./helpers/fakeHub.js";

const env = setupTestEnv("runner");
const { saveConfig, saveToken, loadConfig, paths } = await import("../src/config.js");
const { startRunner } = await import("../src/runner.js");
const { silentLogger } = await import("../src/log.js");
type Running = Awaited<ReturnType<typeof startRunner>>;

let hub: FakeHub;
let runner: Running;

function readArgs(): { argv: string[]; stdin: string; env: Record<string, unknown>; cwd: string }[] {
  if (!existsSync(env.argsFile)) return [];
  return readFileSync(env.argsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeAll(async () => {
  hub = await new FakeHub().start();
  saveConfig({ hubUrl: hub.url, workspaceId: "ws_1", runnerId: null, name: "maquina-teste" });
  saveToken(hub.runnerToken);
  runner = await startRunner({ isolation: "none", capacity: 2, logger: silentLogger, noSignals: true });
  await hub.waitFor("hello");
  await until(() => runner.connection.connected);
});

afterAll(async () => {
  await runner?.stop();
  await hub?.close();
});

afterEach(async () => {
  await runner.jobs.idle();
  writeFileSync(env.argsFile, "");
});

describe("conexão", () => {
  it("envia hello com CLIs, isolamento e capacidade, e guarda o runnerId do welcome", async () => {
    const hello = hub.hellos[0]!;
    expect(hello.protocol).toBe(1);
    expect(hello.runnerId).toBeNull();
    expect(hello.name).toBe("maquina-teste");
    expect(hello.isolation).toBe("none");
    expect(hello.capacity).toBe(2);
    expect(hello.clis).toEqual([{ cli: "claude", version: "9.9.9", loggedIn: true }]);
    expect(hello.platform).toMatch(/linux|darwin/);
    await until(() => loadConfig().runnerId === "run_1");
  });

  it("responde ping/pong (keepalive) sem erro", async () => {
    runner.connection.send({ type: "ping" });
    await hub.waitFor("ping");
  });
});

describe("execução de jobs", () => {
  it("executa um job completo: accepted, stream acumulado, evento de ferramenta e done com tokens e modelo", async () => {
    const a = makeAssignment(hub.url);
    hub.assign(a);
    const done = await hub.waitFor("job.done", (m) => m.jobId === a.jobId);
    const accepted = hub.of("job.accepted", a.jobId)[0]!;
    expect(accepted.cli).toBe("claude");

    expect(done.text).toBe("Tudo certo: há 2 canais.");
    expect(done.model).toBe("claude-fake-1");
    expect(done.inputTokens).toBe(1103);
    expect(done.outputTokens).toBe(42);

    const streams = hub.of("job.stream", a.jobId);
    expect(streams.length).toBeGreaterThan(0);
    // Limite de frequência: 9 pedaços de texto em ~200 ms não podem virar 9 mensagens.
    expect(streams.length).toBeLessThan(9);
    // O texto é sempre acumulado e cresce.
    for (let i = 1; i < streams.length; i++) expect(streams[i]!.text.startsWith(streams[i - 1]!.text)).toBe(true);
    expect(streams.at(-1)!.text).not.toContain("IGNORAR");

    const events = hub.of("job.event", a.jobId);
    expect(events.some((e) => e.kind === "tool" && e.summary.startsWith("listar_canais"))).toBe(true);

    // Ambiente da CLI filha limpo e prompt montado.
    const [call] = readArgs();
    expect(call!.env.CLAUDECODE).toBeNull();
    expect(call!.env.CLAUDE_CODE_ENTRYPOINT).toBeNull();
    expect(call!.env.CLAUDE_CONFIG_DIR).toBe(paths.cliState("claude", "ws_1", "ag_1"));
    expect(call!.env.HAS_JOB_TOKEN).toBe(true);
    expect(call!.cwd).toBe(paths.agentDir("ws_1", "ag_1"));
    expect(call!.argv).toContain("--strict-mcp-config");
    expect(call!.argv).toContain("--append-system-prompt-file");
    expect(call!.stdin).toContain("Quantos canais temos?");
    expect(call!.stdin).toContain("Renato");
    expect(call!.stdin).toContain("#geral");
    expect(call!.stdin).toContain("O time usa TypeScript.");
    expect(call!.stdin).toContain("@tito");
    // Skill gravada no formato do Claude Code.
    const skill = path.join(paths.agentDir("ws_1", "ag_1"), ".claude", "skills", "revisar-pr", "SKILL.md");
    expect(readFileSync(skill, "utf8")).toContain("name: revisar-pr");
    // Pasta temporária do job (com mcp.json) apagada.
    await runner.jobs.idle();
    expect(existsSync(paths.runDir(a.jobId))).toBe(false);
  });

  it("retoma a sessão no segundo job com o mesmo sessionKey", async () => {
    const a1 = makeAssignment(hub.url, { sessionKey: "ag_1:c_resume" });
    hub.assign(a1);
    await hub.waitFor("job.done", (m) => m.jobId === a1.jobId);
    const a2 = makeAssignment(hub.url, { sessionKey: "ag_1:c_resume", prompt: "E agora?" });
    hub.assign(a2);
    await hub.waitFor("job.done", (m) => m.jobId === a2.jobId);
    const calls = readArgs();
    expect(calls[0]!.argv).not.toContain("--resume");
    const idx = calls[1]!.argv.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    const sessions = JSON.parse(readFileSync(paths.sessions(), "utf8"));
    expect(sessions["ag_1:c_resume"].sessionId).toBe(calls[1]!.argv[idx + 1]);
  });

  it("se a sessão salva não existe mais, recomeça sem retomar", async () => {
    const { SessionStore } = await import("../src/config.js");
    new SessionStore().set("ag_1:c_gone", { cli: "claude", sessionId: "gone", updatedAt: Date.now() });
    const a = makeAssignment(hub.url, { sessionKey: "ag_1:c_gone" });
    hub.assign(a);
    const done = await hub.waitFor("job.done", (m) => m.jobId === a.jobId);
    expect(done.text).toBe("Tudo certo: há 2 canais.");
    const calls = readArgs();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv).not.toContain("--resume");
  });

  it("falha de login vira errorCode auth", async () => {
    const a = makeAssignment(hub.url, { prompt: "MODE:auth" });
    hub.assign(a);
    const f = await hub.waitFor("job.failed", (m) => m.jobId === a.jobId);
    expect(f.errorCode).toBe("auth");
    expect(f.error).toMatch(/login/i);
  });

  it("limite do plano vira errorCode limit", async () => {
    const a = makeAssignment(hub.url, { prompt: "MODE:limit" });
    hub.assign(a);
    const f = await hub.waitFor("job.failed", (m) => m.jobId === a.jobId);
    expect(f.errorCode).toBe("limit");
  });

  it("erro genérico da CLI vira errorCode error", async () => {
    const a = makeAssignment(hub.url, { prompt: "MODE:crash" });
    hub.assign(a);
    const f = await hub.waitFor("job.failed", (m) => m.jobId === a.jobId);
    expect(f.errorCode).toBe("error");
    expect(f.error).toContain("panic");
  });

  it("tempo limite mata o processo e vira errorCode timeout", async () => {
    const a = makeAssignment(hub.url, { prompt: "MODE:slow", timeoutMs: 800 });
    hub.assign(a);
    const f = await hub.waitFor("job.failed", (m) => m.jobId === a.jobId);
    expect(f.errorCode).toBe("timeout");
    const pids = JSON.parse(readFileSync(env.pidFile, "utf8")) as { parent: number; child: number };
    await until(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000);
  });

  it("job.cancel mata o processo e os filhos", async () => {
    writeFileSync(env.pidFile, "");
    const a = makeAssignment(hub.url, { prompt: "MODE:slow" });
    hub.assign(a);
    await hub.waitFor("job.stream", (m) => m.jobId === a.jobId);
    const pids = JSON.parse(readFileSync(env.pidFile, "utf8")) as { parent: number; child: number };
    expect(isAlive(pids.parent)).toBe(true);
    expect(isAlive(pids.child)).toBe(true);
    hub.send({ type: "job.cancel", jobId: a.jobId });
    await until(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000);
    await runner.jobs.idle();
    expect(hub.of("job.done", a.jobId)).toHaveLength(0);
    expect(hub.of("job.failed", a.jobId)).toHaveLength(0);
  });

  it("recusa quando passa da capacidade", async () => {
    const a = makeAssignment(hub.url, { prompt: "MODE:slow" });
    const b = makeAssignment(hub.url, { prompt: "MODE:slow" });
    const c = makeAssignment(hub.url, { prompt: "MODE:slow" });
    hub.assign(a);
    hub.assign(b);
    hub.assign(c);
    const r = await hub.waitFor("job.rejected", (m) => m.jobId === c.jobId);
    expect(r.reason).toMatch(/capacidade/);
    hub.send({ type: "job.cancel", jobId: a.jobId });
    hub.send({ type: "job.cancel", jobId: b.jobId });
  });

  it("recusa quando a CLI preferida do agente não existe neste runner", async () => {
    const base = makeAssignment(hub.url);
    const a = makeAssignment(hub.url, { agent: { ...base.agent, preferredCli: "gemini" } });
    hub.assign(a);
    const r = await hub.waitFor("job.rejected", (m) => m.jobId === a.jobId);
    expect(r.reason).toMatch(/gemini/);
  });
});

describe("reconexão", () => {
  it("reconecta com backoff, manda hello com o runnerId e entrega o resultado guardado", async () => {
    const before = hub.hellos.length;
    const a = makeAssignment(hub.url);
    hub.assign(a);
    await hub.waitFor("job.accepted", (m) => m.jobId === a.jobId);
    hub.dropAll();
    // O job termina enquanto a conexão está fora; o done fica na fila e sai após o welcome.
    // Espera o hello da conexão nova (não só a conexão: o hello chega um instante depois dela).
    await until(() => hub.hellos.length > before, 10_000);
    const hello = hub.hellos.at(-1)!;
    expect(hello.runnerId).toBe("run_1");
    const done = await hub.waitFor("job.done", (m) => m.jobId === a.jobId);
    expect(done.text).toBe("Tudo certo: há 2 canais.");
  });
});

describe("revisão automática de memória", () => {
  const utilArgs = (): { argv: string[]; stdin: string; env: { HAS_JOB_TOKEN: boolean } }[] => {
    const f = `${env.argsFile}.utility`;
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const memories = [
    { scope: "team" as const, content: "O Acme paga no dia 5.", id: "mem_acme", removable: true },
    { scope: "team" as const, content: "Regra escrita pela Ana.", id: "mem_ana", removable: false },
  ];

  it("depois do job.done, chama a CLI sem ferramentas e manda ao hub o que guardar e apagar", async () => {
    writeFileSync(`${env.argsFile}.utility`, "");
    const before = hub.toolCalls.length;
    const review = { add: [{ scope: "team", content: "O Acme paga no dia 20." }], remove: ["m1", "m2", "m9"] };
    const a = makeAssignment(hub.url, { prompt: `O Acme mudou o pagamento. REVIEW:${JSON.stringify(review)}`, memories });
    // O hub devolve a lista atual: o agente gravou uma memória durante o trabalho.
    hub.toolResponses.set("GET /api/tool/memories", [
      200,
      {
        items: [
          { id: "mem_acme", scope: "team", content: "O Acme paga no dia 5.", source: "agent" },
          { id: "mem_ana", scope: "team", content: "Regra escrita pela Ana.", source: "user" },
          { id: "mem_nova", scope: "agent", content: "Gravada durante o trabalho.", source: "agent" },
        ],
      },
    ]);
    hub.assign(a);
    await hub.waitFor("job.done", (m) => m.jobId === a.jobId);
    await until(() => hub.toolCalls.slice(before).some((c) => c.path === "/api/tool/memories/review"));
    hub.toolResponses.delete("GET /api/tool/memories");
    const call = hub.toolCalls.slice(before).find((c) => c.path === "/api/tool/memories/review")!;
    expect(call.method).toBe("POST");
    expect(call.auth).toBe(`Bearer ${a.jobToken}`);
    // m2 é fixa (escrita por uma pessoa) e m9 não existe: só o apelido removível vira id real.
    expect(call.body).toEqual({ add: [{ scope: "team", content: "O Acme paga no dia 20." }], remove: ["mem_acme"], usage: { inputTokens: 700, outputTokens: 40 } });

    const u = utilArgs().at(-1)!;
    expect(u.argv[u.argv.indexOf("--tools") + 1]).toBe("");
    expect(u.argv).toContain("--system-prompt-file");
    expect(u.argv).not.toContain("--append-system-prompt-file");
    expect(u.argv).not.toContain("--resume");
    expect(u.argv[u.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(u.env.HAS_JOB_TOKEN).toBe(false);
    expect(u.stdin).toContain("m1 [time] O Acme paga no dia 5.");
    expect(u.stdin).toContain("m2 [time; fixa, não remover] Regra escrita pela Ana.");
    expect(u.stdin).toContain("m3 [agente] Gravada durante o trabalho.");
    expect(u.stdin).not.toContain("mem_acme");
    // Nada da revisão vai para a conversa.
    expect(hub.of("job.stream", a.jobId).every((e) => !e.text.includes("revisão"))).toBe(true);
  });

  it("não roda quando o agente não pode escrever memória", async () => {
    writeFileSync(`${env.argsFile}.utility`, "");
    const base = makeAssignment(hub.url);
    const a = makeAssignment(hub.url, { agent: { ...base.agent, toolPerms: { ...base.agent.toolPerms, memory: "read" } } });
    const before = hub.toolCalls.length;
    hub.assign(a);
    await hub.waitFor("job.done", (m) => m.jobId === a.jobId);
    await runner.jobs.idle();
    expect(utilArgs()).toHaveLength(0);
    expect(hub.toolCalls.slice(before).some((c) => c.path === "/api/tool/memories/review")).toBe(false);
  });
});

describe("encerramento", () => {
  it("SIGTERM/stop devolve os jobs em andamento ao hub (job.rejected runner_shutdown)", async () => {
    writeFileSync(env.pidFile, "");
    const a = makeAssignment(hub.url, { prompt: "MODE:slow" });
    hub.assign(a);
    await hub.waitFor("job.stream", (m) => m.jobId === a.jobId);
    const pids = JSON.parse(readFileSync(env.pidFile, "utf8")) as { parent: number; child: number };
    await runner.stop();
    const r = await hub.waitFor("job.rejected", (m) => m.jobId === a.jobId);
    expect(r.reason).toMatch(/^runner_shutdown/);
    await until(() => !isAlive(pids.parent) && !isAlive(pids.child), 5000);
    expect(existsSync(paths.pid())).toBe(false);
  });
});
