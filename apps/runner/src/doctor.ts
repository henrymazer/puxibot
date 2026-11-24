/** `puxibot doctor` e `puxibot status`. */
import { existsSync, readFileSync } from "node:fs";
import { ADAPTERS, detectClis } from "./adapters/index.js";
import type { CliStatus } from "./adapters/types.js";
import path from "node:path";
import { loadConfig, loadToken, paths, tokenFileMode } from "./config.js";
import { detectIsolation, expandHome, sandboxPlan, type IsolationStatus } from "./isolation.js";
import { runnerPlatform } from "./runner.js";

export interface DoctorReport {
  platform: string;
  node: string;
  clis: CliStatus[];
  isolation: IsolationStatus;
  /** O que o sandbox esconde e libera nesta máquina. */
  sandbox: { hidden: string[]; extraReadOnly: string[]; extraWritable: string[] };
  /** Limitações conhecidas (mostradas sempre). */
  limitations: string[];
  missing: string[];
}

/** Limitações que a pessoa precisa conhecer; não são problemas desta máquina. */
export const LIMITATIONS = [
  "Conectores: o runner põe um intermediário (puxibot mcp-proxy) entre a CLI e cada conector. Antes de cada chamada ele pergunta ao hub se a ação pode rodar: leituras rodam; ações que alteram algo rodam quando o pedido, uma regra do responsável ou uma aprovação cobrem. Conector liberado como \"somente leitura\" só expõe as ferramentas que o próprio servidor marca como somente leitura (readOnlyHint), o que depende de o servidor marcar corretamente. Recursos e prompts do conector não são repassados. O segredo do conector precisa estar dentro do isolamento, então um agente que use o shell de propósito para chamar o serviço direto não é impedido: é uma barreira no caminho normal, não contra um agente malicioso com terminal.",
  "Navegador: desligado por padrão. Para ligar neste computador: \"browser\": { \"enabled\": true } no config.json, e `npx playwright install chromium` uma vez. Senhas vêm do cofre do Puxibot e não são mostradas ao agente; um site recebe tudo o que o agente envia a ele.",
  "Ambiente: nos modos sandbox e container a CLI recebe só PATH, LANG, LC_*, TERM, TZ, HOME, USER, SHELL, as variáveis de proxy e as de login que o adaptador conhece; as outras variáveis do seu terminal (tokens, chaves de nuvem) não passam. Para liberar uma: \"env\": { \"pass\": [\"NOME\"] } no config.json.",
  "Rede: liberada no sandbox e no container (o agente alcança a internet e serviços da rede local). Para cortar: \"sandbox\": { \"network\": false } (corta também o modelo) ou \"container\": { \"network\": \"<rede com proxy>\" }.",
];

const LOGIN_HINT: Record<string, string> = {
  claude: "rode `claude` e entre com sua conta (ou `claude auth login`)",
  codex: "rode `codex login`",
  gemini: "rode `gemini` uma vez e escolha \"Login with Google\" (ou defina GEMINI_API_KEY)",
};
const INSTALL_HINT: Record<string, string> = {
  claude: "instale o Claude Code: https://docs.claude.com/claude-code",
  codex: "instale o Codex CLI: `npm install -g @openai/codex`",
  gemini: "instale o Gemini CLI: `npm install -g @google/gemini-cli`",
};

export async function doctor(): Promise<DoctorReport> {
  const cfg = loadConfig();
  const [clis, isolation] = await Promise.all([detectClis(cfg), detectIsolation(cfg)]);
  const missing: string[] = [];
  const usable = clis.filter((c) => c.installed && c.loggedIn !== false);
  if (!usable.length) missing.push("nenhuma CLI de IA pronta: instale e entre em pelo menos uma (Claude Code, Codex ou Gemini CLI)");
  for (const c of clis) {
    if (!c.installed) continue;
    if (c.loggedIn === false) missing.push(`${ADAPTERS[c.cli].displayName} instalado mas sem login: ${LOGIN_HINT[c.cli]}`);
  }
  if (!isolation.sandbox.available) {
    missing.push(
      process.platform === "linux"
        ? `sandbox indisponível (${isolation.sandbox.detail}). No Ubuntu/WSL2: \`sudo apt install bubblewrap\``
        : `sandbox indisponível (${isolation.sandbox.detail})`,
    );
  }
  if (!isolation.container.available) missing.push(`modo container opcional indisponível: ${isolation.container.detail} (recomendado: Podman ou Docker)`);
  if (!loadToken()) missing.push("runner não pareado com um hub: rode `puxibot login <url-do-hub>`");
  const plan = sandboxPlan(
    { mode: "sandbox", jobId: "doctor", command: "true", args: [], env: {}, workdir: paths.home(), writable: [], readable: [], credentials: [] },
    cfg,
  );
  const sandbox = {
    hidden: [...plan.hiddenDirs, ...plan.hiddenFiles],
    extraReadOnly: (cfg.sandbox?.extraReadOnly ?? []).map(expandHome),
    extraWritable: (cfg.sandbox?.extraWritable ?? []).map(expandHome),
  };
  return { platform: runnerPlatform(), node: process.version, clis, isolation, sandbox, limitations: LIMITATIONS, missing };
}

export function formatDoctor(r: DoctorReport): string {
  const out: string[] = [];
  out.push(`Puxibot doctor — ${r.platform}, Node ${r.node}`, "", "CLIs de IA:");
  for (const c of r.clis) {
    const name = ADAPTERS[c.cli].displayName;
    if (!c.installed) {
      out.push(`  ✗ ${name}: não encontrado — ${INSTALL_HINT[c.cli]}`);
      continue;
    }
    const login = c.loggedIn === true ? "logado" : c.loggedIn === false ? "SEM LOGIN" : "login não verificável";
    const verified = ADAPTERS[c.cli].verified ? "" : " [adaptador ainda não testado com a CLI real]";
    out.push(`  ${c.loggedIn === false ? "!" : "✓"} ${name} ${c.version ?? "?"} — ${login}${c.detail ? ` (${c.detail})` : ""}${verified}`);
  }
  out.push("", "Isolamento:");
  out.push(`  ${r.isolation.sandbox.available ? "✓" : "✗"} sandbox: ${r.isolation.sandbox.detail}`);
  out.push(`  ${r.isolation.container.available ? "✓" : "✗"} container: ${r.isolation.container.detail}`);
  out.push("  ✓ none: sempre disponível (sem isolamento; só para testes)");
  out.push("", "No modo sandbox:");
  out.push(`  escondido: ${r.sandbox.hidden.join(", ") || "(nada)"}`);
  out.push("  somente leitura: o resto do sistema (/usr, /etc, /bin, /lib*, /opt...), o binário da CLI e do Node e o próprio runner");
  out.push(`  com escrita: a pasta de trabalho do agente, o estado da CLI desse agente (${path.join(paths.home(), "cli-state", "<cli>", "<workspace>", "<agente>")}) e /tmp do job`);
  out.push(`  liberado por você: ${[...r.sandbox.extraReadOnly.map((p) => `${p} (leitura)`), ...r.sandbox.extraWritable.map((p) => `${p} (escrita)`)].join(", ") || "nada (use sandbox.extraReadOnly / sandbox.extraWritable no config.json; veja puxibot --help)"}`);
  out.push("", "Limitações conhecidas:");
  for (const l of r.limitations) out.push(`  - ${l}`);
  out.push("");
  if (r.missing.length) {
    out.push("O que falta:");
    for (const m of r.missing) out.push(`  - ${m}`);
  } else out.push("Tudo pronto.");
  return out.join("\n");
}

export function status(): string {
  const cfg = loadConfig();
  const hasToken = !!loadToken();
  const mode = tokenFileMode();
  const out: string[] = [];
  out.push(`Pasta de configuração: ${paths.home()}`);
  if (!cfg.hubUrl || !hasToken) {
    out.push("Não conectado a nenhum hub. Rode `puxibot login <url-do-hub>`.");
    return out.join("\n");
  }
  out.push(`Hub: ${cfg.hubUrl}`, `Workspace: ${cfg.workspaceId ?? "?"}`, `Runner: ${cfg.runnerId ?? "(ainda não registrado; será na primeira conexão)"}`);
  out.push(`Nome: ${cfg.name ?? "(nome da máquina)"}`);
  out.push(`Token: salvo${mode !== null && mode !== 0o600 ? ` (ATENÇÃO: permissão ${mode.toString(8)}, deveria ser 600)` : ""}`);
  out.push(`Isolamento padrão: ${cfg.isolation ?? "sandbox"}; capacidade: ${cfg.capacity ?? 1}`);
  let running = "parado";
  if (existsSync(paths.pid())) {
    const pid = Number(readFileSync(paths.pid(), "utf8").trim());
    try {
      if (pid) process.kill(pid, 0);
      running = `rodando (pid ${pid})`;
    } catch {
      running = "parado (arquivo de pid antigo)";
    }
  }
  out.push(`puxibot start: ${running}`);
  return out.join("\n");
}
