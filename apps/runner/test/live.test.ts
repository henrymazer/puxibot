/**
 * Testes REAIS com o Claude Code (gastam uso da assinatura). Só rodam com
 * PUXIBOT_LIVE=1. Precisam do runner compilado (`npm run build -w @puxibot/runner`),
 * porque o `puxibot mcp` é iniciado a partir do dist.
 *
 *   PUXIBOT_LIVE=1 npx vitest run test/live.test.ts
 *   PUXIBOT_LIVE=1 PUXIBOT_LIVE_MODES=sandbox npx vitest run test/live.test.ts
 *   PUXIBOT_LIVE=1 PUXIBOT_LIVE_MODES=container PUXIBOT_LIVE_RUNTIME=podman npx vitest run test/live.test.ts
 *
 * Modelo: o mais barato (`haiku`, ou PUXIBOT_LIVE_MODEL).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolationMode } from "@puxibot/shared";
import { FakeHub, makeAssignment } from "./helpers/fakeHub.js";
import { RUNNER_ROOT } from "./helpers/env.js";

const LIVE = process.env.PUXIBOT_LIVE === "1";
const MODES = (process.env.PUXIBOT_LIVE_MODES ?? "sandbox,container,none").split(",").filter(Boolean) as IsolationMode[];
const MODEL = process.env.PUXIBOT_LIVE_MODEL ?? "haiku";
/** Força o runtime do modo container (`docker` ou `podman`); sem isso, vale a detecção automática. */
const RUNTIME = process.env.PUXIBOT_LIVE_RUNTIME as "docker" | "podman" | undefined;

describe.runIf(LIVE)("Claude Code de verdade", () => {
  let hub: FakeHub;
  const base = mkdtempSync(path.join(process.env.PUXIBOT_TEST_TMP ?? os.tmpdir(), "puxibot-live-"));

  beforeAll(async () => {
    if (!existsSync(path.join(RUNNER_ROOT, "dist", "cli.js"))) throw new Error("rode o build antes dos testes reais");
    process.env.PUXIBOT_HOME = path.join(base, "home");
    process.env.PUXIBOT_CODEX_BIN = path.join(base, "sem-codex");
    process.env.PUXIBOT_GEMINI_BIN = path.join(base, "sem-gemini");
    process.env.PUXIBOT_LOG_LEVEL = process.env.PUXIBOT_LOG_LEVEL ?? "info";
    hub = await new FakeHub().start();
  });
  afterAll(async () => {
    await hub?.close();
  });

  for (const mode of MODES) {
    describe(`isolamento ${mode}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let runner: any;
      const escapeFile = path.join(os.homedir(), `puxibot-live-escape-${mode}-${process.pid}.txt`);
      const sessionKey = `ag_live:${mode}`;
      let firstSession: string | null = null;

      beforeAll(async () => {
        const { saveConfig, saveToken } = await import("../src/config.js");
        const { startRunner } = await import("../src/runner.js");
        const { createLogger } = await import("../src/log.js");
        saveConfig({ hubUrl: hub.url, workspaceId: "ws_1", runnerId: null, name: `live-${mode}`, models: { claude: MODEL }, ...(RUNTIME ? { container: { runtime: RUNTIME } } : {}) });
        saveToken(hub.runnerToken);
        runner = await startRunner({ isolation: mode, capacity: 1, noSignals: true, logger: createLogger(`live-${mode}`) });
        await hub.waitFor("hello", (h) => h.isolation === mode);
        rmSync(escapeFile, { force: true });
      }, 60_000);

      afterAll(async () => {
        await runner?.stop();
        rmSync(escapeFile, { force: true });
      });

      it(
        "responde com tokens e modelo, usa uma ferramenta MCP nativa" + (mode === "sandbox" ? " e não consegue escrever fora da pasta" : ""),
        async () => {
          const before = hub.toolCalls.length;
          if (mode === "sandbox") {
            // Script inocente na pasta do agente que tenta escrever fora dela.
            const { paths } = await import("../src/config.js");
            const dir = paths.agentDir("ws_1", "ag_live");
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "verificar.sh"), `echo x > ${escapeFile} 2>&1; echo "resultado=$?"\n`);
          }
          const steps = [
            `1. Chame a ferramenta reportar_progresso do servidor puxibot com summary "teste-live-${mode}".`,
            mode === "sandbox"
              ? "2. Com a ferramenta Bash, rode `sh ./verificar.sh` na sua pasta de trabalho e anote a última linha que ele imprimir."
              : "2. (sem passo 2)",
            `3. Termine respondendo numa linha: "PALAVRA=girassol" seguida do resultado do passo 2, se houver.`,
          ].join("\n");
          const a = makeAssignment(hub.url, {
            prompt: `Teste automático do runner. Faça exatamente:\n${steps}`,
            sessionKey,
            agent: { ...makeAssignment(hub.url).agent, id: "ag_live", handle: "teste", name: "Teste", instructions: "Responda de forma curtíssima." },
            context: [],
            timeoutMs: 240_000,
          });
          hub.assign(a);
          const done = await Promise.race([
            hub.waitFor("job.done", (m) => m.jobId === a.jobId, 240_000),
            hub.waitFor("job.failed", (m) => m.jobId === a.jobId, 240_000).then((f) => {
              throw new Error(`job falhou: ${f.errorCode} ${f.error}`);
            }),
          ]);
          process.stderr.write(`[${mode}] resposta: ${JSON.stringify(done.text)} | tokens ${done.inputTokens}/${done.outputTokens} | ${done.model}\n`);
          expect(done.text).toContain("girassol");
          expect(done.inputTokens).toBeGreaterThan(0);
          expect(done.outputTokens).toBeGreaterThan(0);
          expect(done.model).toMatch(/claude/);
          const call = hub.toolCalls.slice(before).find((c) => c.path === "/api/tool/progress");
          expect(call, "o agente deveria ter chamado reportar_progresso").toBeTruthy();
          expect(call!.auth).toBe(`Bearer ${a.jobToken}`);
          expect(call!.body).toEqual({ summary: `teste-live-${mode}` });
          expect(hub.of("job.event", a.jobId).some((e) => e.summary.startsWith("reportar_progresso"))).toBe(true);
          expect(hub.of("job.stream", a.jobId).length).toBeGreaterThan(0);
          if (mode === "sandbox") {
            // O agente tentou de fato (evento de ferramenta Bash) e o arquivo não apareceu.
            expect(hub.of("job.event", a.jobId).some((e) => e.summary.startsWith("Bash"))).toBe(true);
            expect(done.text).toMatch(/resultado=[1-9]/);
            expect(existsSync(escapeFile)).toBe(false);
          }
          const { paths } = await import("../src/config.js");
          firstSession = JSON.parse(readFileSync(paths.sessions(), "utf8"))[sessionKey]?.sessionId ?? null;
          expect(firstSession).toBeTruthy();
        },
        300_000,
      );

      it(
        "retoma a sessão num segundo job com o mesmo sessionKey",
        async () => {
          const a = makeAssignment(hub.url, {
            prompt: "Qual foi a PALAVRA que você escreveu na sua resposta anterior nesta conversa? Responda só a palavra.",
            sessionKey,
            agent: { ...makeAssignment(hub.url).agent, id: "ag_live", handle: "teste", name: "Teste", instructions: "Responda de forma curtíssima." },
            context: [],
            timeoutMs: 180_000,
          });
          hub.assign(a);
          const done = await Promise.race([
            hub.waitFor("job.done", (m) => m.jobId === a.jobId, 180_000),
            hub.waitFor("job.failed", (m) => m.jobId === a.jobId, 180_000).then((f) => {
              throw new Error(`job falhou: ${f.errorCode} ${f.error}`);
            }),
          ]);
          process.stderr.write(`[${mode}] retomada: ${done.text}\n`);
          expect(done.text.toLowerCase()).toContain("girassol");
          const { paths } = await import("../src/config.js");
          expect(JSON.parse(readFileSync(paths.sessions(), "utf8"))[sessionKey]?.sessionId).toBe(firstSession);
        },
        240_000,
      );
    });
  }
});
