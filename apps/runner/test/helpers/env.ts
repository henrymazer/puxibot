import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude.mjs");
export const RUNNER_ROOT = path.resolve(FIXTURES, "..", "..");

/** Pasta temporária isolada para PUXIBOT_HOME e para a "config da pessoa" da CLI. */
export function setupTestEnv(name: string): { home: string; userClaude: string; argsFile: string; pidFile: string } {
  const base = mkdtempSync(path.join(process.env.PUXIBOT_TEST_TMP ?? os.tmpdir(), `puxibot-${name}-`));
  const home = path.join(base, "home");
  const userClaude = path.join(base, "user-claude");
  mkdirSync(userClaude, { recursive: true });
  writeFileSync(
    path.join(userClaude, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 24 * 3600_000 } }),
    { mode: 0o600 },
  );
  chmodSync(FAKE_CLAUDE, 0o755);
  process.env.PUXIBOT_HOME = home;
  process.env.PUXIBOT_USER_CLAUDE_DIR = userClaude;
  process.env.PUXIBOT_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.PUXIBOT_CODEX_BIN = path.join(base, "nao-existe-codex");
  process.env.PUXIBOT_GEMINI_BIN = path.join(base, "nao-existe-gemini");
  process.env.PUXIBOT_LOG_LEVEL = process.env.PUXIBOT_LOG_LEVEL ?? "warn";
  const argsFile = path.join(base, "args.jsonl");
  const pidFile = path.join(base, "pids.json");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.FAKE_PID_FILE = pidFile;
  // Simula estar dentro de uma sessão do Claude Code: o runner precisa limpar.
  process.env.CLAUDECODE = "1";
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  return { home, userClaude, argsFile, pidFile };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(pred: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("condição não satisfeita a tempo");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
