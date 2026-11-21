import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestEnv } from "./helpers/env.js";

const env = setupTestEnv("iso");
const { bubblewrapArgs, containerArgs, detectIsolation, externalMounts, sandboxEnv, sandboxPlan, seatbeltProfile, symlinkChain } = await import("../src/isolation.js");
const { paths } = await import("../src/config.js");
const { cleanEnv } = await import("../src/proc.js");

const workdir = paths.agentDir("ws_1", "ag_1");
mkdirSync(workdir, { recursive: true });
mkdirSync(paths.cliState("claude", "ws_1", "ag_1"), { recursive: true });
writeFileSync(path.join(env.home, "token"), "tb_segredo\n", { mode: 0o600 });

const req = {
  mode: "sandbox" as const,
  jobId: "job_1",
  command: "sh",
  args: ["-c", "true"],
  env: {},
  workdir,
  writable: [paths.cliState("claude", "ws_1", "ag_1")],
  readable: [],
  credentials: [{ path: path.join(env.userClaude, ".credentials.json"), writable: false }],
};

describe("ambiente da CLI filha", () => {
  it("remove variáveis de sessão herdadas do Claude Code e do Puxibot", () => {
    const e = cleanEnv({
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CONFIG_DIR: "/a",
      PUXIBOT_JOB_TOKEN: "tbj_x",
      CODEX_SANDBOX: "seatbelt",
      HOME: "/h",
    });
    expect(e).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("sandbox (bubblewrap)", () => {
  it("monta raiz somente leitura, esconde a pasta pessoal, /home, /mnt e ~/.puxibot e libera só as pastas do job", () => {
    const a = bubblewrapArgs(req, {});
    const s = a.join(" ");
    expect(s).toContain("--ro-bind / /");
    expect(s).toContain(`--tmpfs ${os.homedir()}`);
    expect(s).toContain(`--remount-ro ${os.homedir()}`);
    for (const d of ["/home", "/mnt", "/root"]) if (existsSync(d)) expect(s).toContain(`--tmpfs ${d}`);
    // PUXIBOT_HOME do teste fica em /tmp, que já é um tmpfs novo no sandbox.
    expect(env.home.startsWith("/tmp/") || s.includes(`--tmpfs ${env.home}`)).toBe(true);
    expect(s).toContain(`--bind ${workdir} ${workdir}`);
    expect(s).toContain(`--ro-bind ${req.credentials[0]!.path} ${req.credentials[0]!.path}`);
    expect(a.indexOf(`--tmpfs`) < a.indexOf(workdir)).toBe(true);
    expect(s).not.toContain("--unshare-net");
    expect(bubblewrapArgs(req, { sandbox: { network: false } })).toContain("--unshare-net");
  });

  it.runIf(process.platform === "linux" && existsSync("/usr/bin/bwrap"))(
    "na prática: escreve na pasta de trabalho, não escreve fora, não lê o token do runner",
    async () => {
      const st = await detectIsolation();
      if (!st.sandbox.available) return;
      const outside = path.join(os.homedir(), `puxibot-escape-${process.pid}.txt`);
      const script = [
        "echo ok > dentro.txt && echo DENTRO_OK",
        `(echo x > ${outside}) 2>/dev/null && echo FORA_OK || echo FORA_BLOQUEADO`,
        `(cat ${path.join(env.home, "token")}) 2>/dev/null && echo TOKEN_LIDO || echo TOKEN_ESCONDIDO`,
        `(echo y > ${path.join(env.userClaude, ".credentials.json")}) 2>/dev/null && echo CRED_ESCRITA || echo CRED_SOMENTE_LEITURA`,
        "echo t > /tmp/x && echo TMP_OK",
      ].join("; ");
      const args = bubblewrapArgs({ ...req, args: ["-c", script] }, {});
      const r = spawnSync("bwrap", args, { encoding: "utf8" });
      if (!r.stdout.includes("DENTRO_OK")) console.error(r.stderr, args.join(" "));
      expect(r.stdout).toContain("DENTRO_OK");
      expect(r.stdout).toContain("FORA_BLOQUEADO");
      expect(r.stdout).toContain("TOKEN_ESCONDIDO");
      expect(r.stdout).toContain("CRED_SOMENTE_LEITURA");
      expect(r.stdout).toContain("TMP_OK");
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(path.join(workdir, "dentro.txt"))).toBe(true);
    },
  );
});

describe("sandbox: o que fica escondido", () => {
  it("acha discos do Windows, de rede e outros discos em /proc/self/mountinfo, sem pegar os do sistema", () => {
    const mi = [
      "1 0 8:48 / / rw - ext4 /dev/sdd rw",
      "2 1 0:1 / /mnt/c rw - 9p C:\\134 rw",
      "3 1 0:2 / /usr/lib/wsl/drivers ro - 9p drivers ro",
      "4 1 8:1 / /dados rw - ext4 /dev/sdb1 rw",
      "5 1 0:3 / /snap/core/1 ro - fuse.snapfuse snapfuse ro",
      "6 1 0:4 / /run/user/1000 rw - tmpfs tmpfs rw",
      "7 1 0:5 / /srv/rede rw - nfs4 server:/x rw",
      "8 1 8:48 /var/lib/docker /var/lib/docker rw - ext4 /dev/sdd rw",
      "9 1 0:6 / /media/pen\\040drive rw - vfat /dev/sdc1 rw",
    ].join("\n");
    expect(externalMounts(mi).sort()).toEqual(["/dados", "/media/pen drive", "/mnt/c", "/srv/rede"]);
  });

  it("extraReadOnly/extraWritable liberam pastas; o token e ~/.ssh continuam escondidos mesmo liberando a pasta pessoal", () => {
    const extra = path.join(os.homedir());
    const plan = sandboxPlan(req, { sandbox: { extraReadOnly: ["~"], extraWritable: [workdir] } });
    expect(plan.readOnly).toContain(extra);
    const ssh = path.join(os.homedir(), ".ssh");
    if (existsSync(ssh)) expect(plan.secrets).toContain(ssh);
    const a = bubblewrapArgs(req, { sandbox: { extraReadOnly: ["~"] } });
    if (existsSync(ssh)) expect(a.lastIndexOf(ssh)).toBeGreaterThan(a.lastIndexOf(extra));
  });

  it("segue links simbólicos do executável", () => {
    const dir = path.join(env.home, "..", "bin-links");
    mkdirSync(dir, { recursive: true });
    const link = path.join(dir, "meu-sh");
    if (!existsSync(link)) symlinkSync("/bin/sh", link);
    const c = symlinkChain(link);
    expect(c.links[0]).toEqual({ link, target: "/bin/sh" });
    expect(c.real).toBe(realpathSync("/bin/sh"));
  });

  it("caches vão para o /tmp do sandbox", () => {
    expect(sandboxEnv({ A: "1" })).toMatchObject({ A: "1", XDG_CACHE_HOME: "/tmp/.cache" });
  });

  it.runIf(process.platform === "linux" && existsSync("/usr/bin/bwrap"))(
    "na prática: não lê ~/.ssh, arquivos da pasta pessoal, /mnt/c nem o token; node e a CLI real continuam rodando",
    async () => {
      const st = await detectIsolation();
      if (!st.sandbox.available) return;
      const probe = path.join(os.homedir(), `puxibot-probe-${process.pid}.txt`);
      writeFileSync(probe, "segredo-da-pasta-pessoal\n");
      try {
        const claude = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
        const sshDir = path.join(os.homedir(), ".ssh");
        const script = [
          `(ls -A ${sshDir} | grep -q .) 2>/dev/null && echo SSH_LIDO || echo SSH_ESCONDIDO`,
          `(cat ${probe}) 2>/dev/null | grep -q segredo && echo HOME_LIDO || echo HOME_ESCONDIDO`,
          `(ls -A /mnt/c | grep -q .) 2>/dev/null && echo MNT_LIDO || echo MNT_ESCONDIDO`,
          `(ls -A /home | grep -v "^$(basename ${os.homedir()})$" | grep -q .) 2>/dev/null && echo OUTROS_HOME || echo OUTROS_HOME_ESCONDIDOS`,
          `(cat ${path.join(env.home, "token")}) 2>/dev/null && echo TOKEN_LIDO || echo TOKEN_ESCONDIDO`,
          `${process.execPath} -e "console.log('NODE_OK')"`,
          "ls /usr/bin/git >/dev/null 2>&1 && echo SISTEMA_OK",
          // No WSL /etc/resolv.conf aponta para /mnt/wsl: precisa continuar legível (DNS).
          "(cat /etc/resolv.conf >/dev/null 2>&1 || ! test -e /etc/resolv.conf) && echo DNS_OK",
        ].join("; ");
        const r0 = { ...req, command: "sh", args: ["-c", script], env: { PATH: process.env.PATH ?? "" } };
        const args = bubblewrapArgs(r0, {});
        const r = spawnSync("bwrap", args, { encoding: "utf8", env: sandboxEnv({ PATH: process.env.PATH ?? "", HOME: os.homedir() }) });
        if (!r.stdout.includes("NODE_OK")) console.error(r.stderr, args.join(" "));
        expect(r.stdout).toContain("SSH_ESCONDIDO");
        expect(r.stdout).toContain("HOME_ESCONDIDO");
        expect(r.stdout).toContain("MNT_ESCONDIDO");
        expect(r.stdout).toContain("OUTROS_HOME_ESCONDIDOS");
        expect(r.stdout).toContain("TOKEN_ESCONDIDO");
        expect(r.stdout).toContain("NODE_OK");
        if (claude) {
          // A CLI de verdade (onde estiver instalada, inclusive na pasta pessoal) roda como comando do job.
          const cli = spawnSync("bwrap", bubblewrapArgs({ ...req, command: claude, args: ["--version"], env: { PATH: process.env.PATH ?? "" } }, {}), {
            encoding: "utf8",
            env: sandboxEnv({ PATH: process.env.PATH ?? "", HOME: os.homedir() }),
          });
          expect(cli.status, cli.stderr).toBe(0);
        }
        expect(r.stdout).toContain("SISTEMA_OK");
        expect(r.stdout).toContain("DNS_OK");
      } finally {
        rmSync(probe, { force: true });
      }
    },
  );
});

describe("container", () => {
  it("monta pasta de trabalho, estado e credenciais no mesmo caminho e passa variáveis só por nome", () => {
    const a = containerArgs(
      { ...req, mode: "container", env: { PUXIBOT_JOB_TOKEN: "tbj_segredo", PATH: "/x" } },
      {},
      "docker",
      "img:1",
    );
    const s = a.join(" ");
    expect(s).toContain("run --rm --init -i --name puxibot-job-job_1");
    expect(s).toContain(`-v ${workdir}:${workdir}:rw`);
    expect(s).toContain(`-v ${req.credentials[0]!.path}:${req.credentials[0]!.path}:ro`);
    expect(a).toContain("PUXIBOT_JOB_TOKEN");
    expect(s).not.toContain("tbj_segredo");
    expect(a.slice(-4)).toEqual(["img:1", "sh", "-c", "true"]);
  });
});

describe("macOS (Seatbelt, não testado de verdade)", () => {
  it("gera um perfil que nega escrita fora das pastas do job", () => {
    const p = seatbeltProfile(req, {});
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain(workdir);
  });
});
