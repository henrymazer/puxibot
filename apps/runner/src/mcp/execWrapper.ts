/**
 * `puxibot mcp-exec`: inicia um conector stdio com as variáveis de ambiente dele.
 *
 * Usado pelo adaptador do Codex, que só sabe repassar variáveis do próprio ambiente aos
 * servidores MCP. Em vez de pôr as variáveis do conector (vindas do hub) no ambiente do
 * Codex — e com isso no do isolamento —, o runner põe a configuração inteira numa variável
 * de nome fixo (`PUXIBOT_CONN_CFG_<n>`), e este comando, já dentro do isolamento, inicia o
 * conector com elas. Nomes perigosos (PATH, LD_*, NODE_OPTIONS...) são ignorados de novo aqui.
 */
import { spawn } from "node:child_process";
import { filterConnectorEnv } from "../adapters/types.js";

export interface ExecConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Ambiente do conector: o do processo, sem variáveis do Puxibot, mais as do conector. */
export function connectorProcessEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("PUXIBOT_")) continue;
    out[k] = v;
  }
  return { ...out, ...filterConnectorEnv(extra).env };
}

export async function runExecWrapper(configEnv: string): Promise<never> {
  const raw = process.env[configEnv];
  if (!raw) throw new Error(`variável ${configEnv} ausente (o \`puxibot mcp-exec\` é iniciado pela CLI durante um job)`);
  const cfg = JSON.parse(raw) as ExecConfig;
  if (!cfg.command) throw new Error("conector sem comando");
  delete process.env[configEnv];
  const child = spawn(cfg.command, cfg.args ?? [], { stdio: "inherit", env: connectorProcessEnv(cfg.env ?? {}) });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  return new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  });
}
