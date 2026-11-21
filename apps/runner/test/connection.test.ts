import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeHub } from "./helpers/fakeHub.js";
import { HubConnection, runnerWsUrl } from "../src/connection.js";
import { redact, silentLogger } from "../src/log.js";

let hub: FakeHub;
beforeAll(async () => {
  hub = await new FakeHub().start();
});
afterAll(async () => {
  await hub.close();
});

const hello = () => ({
  type: "hello" as const,
  protocol: 1,
  runnerId: null,
  name: "x",
  platform: "linux",
  clis: [],
  isolation: "none" as const,
  capacity: 1,
});

describe("conexão com o hub", () => {
  it("monta a URL do WebSocket a partir do hub", () => {
    expect(runnerWsUrl("https://hub.exemplo.dev", "ws_1")).toBe("wss://hub.exemplo.dev/api/workspaces/ws_1/runner");
    expect(runnerWsUrl("http://127.0.0.1:8787/", "ws 2")).toBe("ws://127.0.0.1:8787/api/workspaces/ws%202/runner");
  });

  it("token recusado (401) para de tentar e avisa", async () => {
    let fatal = "";
    const c = new HubConnection({
      hubUrl: hub.url,
      workspaceId: "ws_1",
      token: "tb_errado",
      hello,
      onMessage: () => {},
      onFatal: (r) => (fatal = r),
      logger: silentLogger,
      backoffBaseMs: 10,
    });
    c.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(fatal).toMatch(/puxibot login/);
    expect(hub.connections).toBe(0);
    await c.stop();
  });

  it("guarda mensagens importantes fora do ar e descarta stream/heartbeat", async () => {
    const c = new HubConnection({
      hubUrl: hub.url,
      workspaceId: "ws_1",
      token: hub.runnerToken,
      hello,
      onMessage: () => {},
      logger: silentLogger,
    });
    c.send({ type: "job.stream", jobId: "j", text: "a" });
    c.send({ type: "job.heartbeat", jobId: "j" });
    c.send({ type: "job.done", jobId: "j", text: "fim", inputTokens: 1, outputTokens: 1, model: null });
    c.start();
    const done = await hub.waitFor("job.done", (m) => m.jobId === "j");
    expect(done.text).toBe("fim");
    expect(hub.of("job.stream", "j")).toHaveLength(0);
    expect(hub.of("job.heartbeat", "j")).toHaveLength(0);
    await c.stop();
  });
});

describe("log", () => {
  it("nunca mostra tokens do Puxibot", () => {
    expect(redact("token tb_abc123 e tbj_x.y.z e Bearer qwe")).toBe("token tb_*** e tbj_*** e Bearer ***");
  });
});
