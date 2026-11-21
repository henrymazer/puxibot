import { readFileSync, statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestEnv } from "./helpers/env.js";
import { FakeHub } from "./helpers/fakeHub.js";

setupTestEnv("pairing");
const { pairWithHub, loginWithToken, normalizeHubUrl } = await import("../src/pairing.js");
const { loadConfig, loadToken, paths } = await import("../src/config.js");
const { status } = await import("../src/doctor.js");

let hub: FakeHub;
beforeAll(async () => {
  hub = await new FakeHub({ pendingPolls: 2 }).start();
});
afterAll(async () => {
  await hub.close();
});

describe("pareamento", () => {
  it("pede o código, mostra para aprovar, consulta até aprovar e grava o token com 0600", async () => {
    let shown: { code: string; url: string } | null = null;
    const r = await pairWithHub(hub.url, {
      name: "notebook",
      pollIntervalMs: 10,
      onCode: (code, url) => (shown = { code, url }),
    });
    expect(shown).toEqual({ code: "QX7-42K", url: `${hub.url}/runner/parear?codigo=QX7-42K` });
    expect(r).toEqual({ hubUrl: hub.url, workspaceId: "ws_1" });
    expect(loadToken()).toBe(hub.runnerToken);
    expect(statSync(paths.token()).mode & 0o777).toBe(0o600);
    expect(statSync(paths.home()).mode & 0o777).toBe(0o700);
    const cfg = loadConfig();
    expect(cfg).toMatchObject({ hubUrl: hub.url, workspaceId: "ws_1", name: "notebook" });
    // O token não aparece no config.json nem no status.
    expect(readFileSync(paths.config(), "utf8")).not.toContain("tb_");
    expect(status()).not.toContain("tb_");
    expect(status()).toContain("Token: salvo");
  });

  it("aceita --token/--workspace e recusa token que o hub não reconhece", async () => {
    await expect(loginWithToken(hub.url, "tb_errado", "ws_1")).rejects.toThrow(/recusou/);
    await expect(loginWithToken(hub.url, "abc", "ws_1")).rejects.toThrow(/tb_/);
    await expect(loginWithToken(hub.url, hub.runnerToken, "ws_outro")).rejects.toThrow(/não é membro/);
    const r = await loginWithToken(hub.url, hub.runnerToken, "ws_9");
    expect(r.workspaceId).toBe("ws_9");
    expect(loadConfig().workspaceId).toBe("ws_9");
  });

  it("avisa quando o código expira (410)", async () => {
    hub.expirePairing = true;
    await expect(pairWithHub(hub.url, { pollIntervalMs: 10, onCode: () => {} })).rejects.toThrow(/expirou/);
    hub.expirePairing = false;
  });

  it("normaliza o endereço do hub", () => {
    expect(normalizeHubUrl("puxibot.exemplo.dev/")).toBe("https://puxibot.exemplo.dev");
    expect(normalizeHubUrl("localhost:8787")).toBe("http://localhost:8787");
  });
});
