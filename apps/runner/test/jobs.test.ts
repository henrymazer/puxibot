import { describe, expect, it } from "vitest";
import type { RunnerToHub } from "@puxibot/shared";
import { setupTestEnv } from "./helpers/env.js";
import { makeAssignment } from "./helpers/fakeHub.js";

setupTestEnv("jobs");
const { JobManager } = await import("../src/jobs.js");
const { silentLogger } = await import("../src/log.js");
const { JOB_HEARTBEAT_MS } = await import("@puxibot/shared");

function manager(sent: RunnerToHub[], heartbeatMs?: number) {
  return new JobManager({
    send: (m) => sent.push(m),
    capacity: 1,
    isolation: "none",
    config: {},
    clis: [
      { cli: "claude", installed: true, path: "x", version: "1", loggedIn: true },
      { cli: "codex", installed: true, path: "x", version: "1", loggedIn: false },
    ],
    logger: silentLogger,
    heartbeatMs,
  });
}

describe("heartbeat", () => {
  it("usa o intervalo do contrato por padrão", () => {
    expect(JOB_HEARTBEAT_MS).toBe(15_000);
  });

  it("envia job.heartbeat periodicamente enquanto o job roda e para depois", async () => {
    const sent: RunnerToHub[] = [];
    const jm = manager(sent, 100);
    const a = makeAssignment("http://127.0.0.1:9", { prompt: "MODE:slow", timeoutMs: 700 });
    jm.handleAssign(a);
    await jm.idle();
    const beats = sent.filter((m) => m.type === "job.heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(4);
    const failed = sent.find((m) => m.type === "job.failed");
    expect(failed && failed.type === "job.failed" && failed.errorCode).toBe("timeout");
    const count = beats.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.filter((m) => m.type === "job.heartbeat").length).toBe(count);
  });
});

describe("escolha da CLI", () => {
  it("não usa CLI sem login, respeita preferredCli e defaultCli", () => {
    const jm = manager([]);
    const base = makeAssignment("http://x");
    expect(jm.availableClis()).toEqual(["claude"]);
    expect(jm.chooseCli(base)).toEqual({ cli: "claude" });
    const codex = jm.chooseCli({ ...base, agent: { ...base.agent, preferredCli: "codex" } });
    expect("reason" in codex && codex.reason).toMatch(/não está logada/);
    const gemini = jm.chooseCli({ ...base, agent: { ...base.agent, preferredCli: "gemini" } });
    expect("reason" in gemini && gemini.reason).toMatch(/não está instalada/);
  });

  it("reentrega do mesmo job só confirma de novo", async () => {
    const sent: RunnerToHub[] = [];
    const jm = manager(sent);
    const a = makeAssignment("http://127.0.0.1:9", { prompt: "MODE:slow" });
    jm.handleAssign(a);
    jm.handleAssign(a);
    expect(sent.filter((m) => m.type === "job.accepted")).toHaveLength(2);
    expect(sent.filter((m) => m.type === "job.rejected")).toHaveLength(0);
    expect(jm.running).toBe(1);
    jm.handleCancel(a.jobId);
    await jm.idle();
  });
});

describe("consulta entre agentes com capacidade 1", () => {
  it("aceita o job filho cujo pai roda aqui acima da capacidade, recusa outros e limita a quantidade", async () => {
    const sent: RunnerToHub[] = [];
    const jm = manager(sent);
    const parent = makeAssignment("http://127.0.0.1:9", { prompt: "MODE:slow" });
    jm.handleAssign(parent);
    // Outro job qualquer: sem capacidade.
    const other = makeAssignment("http://127.0.0.1:9", { prompt: "MODE:slow" });
    jm.handleAssign(other);
    expect(sent.find((m) => m.type === "job.rejected" && m.jobId === other.jobId)).toBeTruthy();
    // Filho de um job que não está aqui: recusado.
    const orphan = makeAssignment("http://127.0.0.1:9", { prompt: "MODE:slow", origin: "agent", parentJobId: "job_de_outro_runner" });
    jm.handleAssign(orphan);
    expect(sent.find((m) => m.type === "job.rejected" && m.jobId === orphan.jobId)).toBeTruthy();
    // Cadeia pai -> filho -> neto -> bisneto: aceitos até CHILD_JOB_EXTRA_CAPACITY a mais.
    const { CHILD_JOB_EXTRA_CAPACITY } = await import("@puxibot/shared");
    let up = parent.jobId;
    const chain = [];
    for (let i = 0; i < CHILD_JOB_EXTRA_CAPACITY + 1; i++) {
      const c = makeAssignment("http://127.0.0.1:9", { prompt: "MODE:slow", origin: "agent", parentJobId: up });
      chain.push(c);
      jm.handleAssign(c);
      up = c.jobId;
    }
    for (const c of chain.slice(0, CHILD_JOB_EXTRA_CAPACITY)) {
      expect(sent.find((m) => m.type === "job.accepted" && m.jobId === c.jobId)).toBeTruthy();
    }
    const last = chain.at(-1)!;
    expect(sent.find((m) => m.type === "job.rejected" && m.jobId === last.jobId)).toBeTruthy();
    expect(jm.running).toBe(1 + CHILD_JOB_EXTRA_CAPACITY);
    for (const id of jm.runningJobIds()) jm.handleCancel(id);
    await jm.idle();
  });
});
