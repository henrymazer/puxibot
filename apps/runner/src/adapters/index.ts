import type { Cli } from "@puxibot/shared";
import type { RunnerConfig } from "../config.js";
import { which } from "../proc.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import type { CliAdapter, CliStatus } from "./types.js";

export const ADAPTERS: Record<Cli, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

/** Ordem de preferência quando o agente não pede uma CLI. */
export const CLI_ORDER: Cli[] = ["claude", "codex", "gemini"];

export function binPathFor(cli: Cli, cfg: RunnerConfig): string {
  const envName = `PUXIBOT_${cli.toUpperCase()}_BIN`;
  return process.env[envName] ?? cfg.cliPaths?.[cli] ?? ADAPTERS[cli].binName;
}

export async function detectClis(cfg: RunnerConfig, only?: Cli[]): Promise<CliStatus[]> {
  const list = only ?? CLI_ORDER;
  return Promise.all(
    list.map(async (cli) => {
      const resolved = await which(binPathFor(cli, cfg));
      try {
        return await ADAPTERS[cli].detect(resolved);
      } catch (e) {
        return { cli, installed: !!resolved, path: resolved, version: null, loggedIn: null, detail: String(e) };
      }
    }),
  );
}

export type { CliAdapter, CliStatus } from "./types.js";
