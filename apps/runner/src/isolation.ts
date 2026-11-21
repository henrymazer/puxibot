/**
 * Isolamento aplicado pelo runner em volta de qualquer CLI.
 *
 * Regra: o agente só alcança a própria pasta de trabalho. No modo `sandbox`:
 *   - continuam visíveis, somente leitura, as pastas do sistema (/usr, /etc, /bin,
 *     /lib*, /opt, /snap...), para o agente ter as ferramentas do sistema;
 *   - ficam ocultas (tmpfs vazio, somente leitura): a pasta pessoal ($HOME), todo o
 *     /home, /root, /mnt (no WSL, o disco do Windows), /media, /run/media, montagens
 *     de discos externos e de rede, sockets que permitiriam escapar (Docker, Podman,
 *     D-Bus, XDG_RUNTIME_DIR) e a pasta do runner (~/.puxibot, com o token);
 *   - voltam: a pasta de trabalho do agente (escrita), o estado da CLI usado pelo
 *     runner (escrita), o temporário do job, as credenciais da CLI, e somente leitura
 *     o mínimo para executar: o binário da CLI e do Node (resolvidos com os links
 *     simbólicos, onde estiverem instalados: nvm, ~/.local/bin, instalação nativa do
 *     Claude Code...) e o próprio runner (para o `puxibot mcp`);
 *   - `sandbox.extraReadOnly` / `sandbox.extraWritable` no config.json liberam pastas
 *     escolhidas pela pessoa.
 * Rede: liberada no modo padrão. Para restringir:
 *   - sandbox (Linux): `"sandbox": { "network": false }` no config.json corta toda
 *     a rede (inclusive a do modelo) — útil só com CLIs locais;
 *   - container: `"container": { "network": "<rede>" }` com uma rede do Docker/Podman
 *     que passe por um proxy com lista de endereços permitidos.
 *
 * Por que bubblewrap direto e não @anthropic-ai/sandbox-runtime: avaliamos o pacote
 * (0.0.83). Ele envolve comandos arbitrários, mas no Linux exige `socat` mesmo com
 * rede liberada (falha no initialize sem ele) e só oferece rede por proxy com lista
 * de permitidos que bloqueia loopback — o que quebra hubs locais (wrangler dev).
 * Como o modo padrão aqui é rede liberada e "nenhuma instalação extra", chamamos o
 * `bwrap` direto.
 */
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IsolationMode } from "@puxibot/shared";
import type { RunnerConfig } from "./config.js";
import { puxibotHome } from "./config.js";
import type { CredentialMount } from "./adapters/types.js";
import type { Logger } from "./log.js";
import { packageDirOf, packageRoot, selfMounts } from "./self.js";
import { run, which } from "./proc.js";

export interface IsolationRequest {
  mode: IsolationMode;
  jobId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Pasta de trabalho do agente (cwd, com escrita). */
  workdir: string;
  writable: string[];
  readable: string[];
  credentials: CredentialMount[];
  /**
   * Executáveis que precisam rodar dentro do sandbox além de `command` (ex.: comandos de
   * conectores stdio). Resolvidos no PATH de `env`, com links simbólicos.
   */
  executables?: string[];
  /** Para o modo container. */
  image?: string;
  /** O hub está em localhost (o container precisa da rede do host para alcançá-lo). */
  hubIsLocal?: boolean;
}

export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
  } catch {
    return false;
  }
}

export interface IsolatedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Encerramento extra (ex.: `docker kill`). */
  kill?: () => Promise<void>;
}

export interface IsolationStatus {
  /** `path`: caminho absoluto do executável, resolvido com o PATH do próprio runner. */
  sandbox: { available: boolean; tool: "bwrap" | "sandbox-exec" | null; detail: string; path?: string | null };
  container: { available: boolean; runtime: "docker" | "podman" | null; detail: string; path?: string | null };
}

/**
 * Caminho absoluto de um executável pelo PATH do runner (nunca o do ambiente da CLI, que
 * poderia apontar para uma pasta que o agente controla).
 */
export function hostExecutable(name: string): string {
  return resolveExecutable(name, process.env.PATH ?? "") ?? name;
}

export function defaultHiddenPaths(): string[] {
  const home = os.homedir();
  const list = [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".config", "gh"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".netrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".npmrc"),
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/podman",
    "/run/dbus",
    // Pasta de execução do usuário (D-Bus da sessão, systemd --user, Podman, gpg-agent...):
    // sempre escondida, mesmo sem XDG_RUNTIME_DIR no ambiente (via `su`, cron, ssh...).
    "/run/user",
  ];
  const uid = process.getuid?.();
  if (uid !== undefined) list.push(`/run/user/${uid}`);
  if (process.env.XDG_RUNTIME_DIR) list.push(process.env.XDG_RUNTIME_DIR);
  return list;
}

// ---------- Detecção ----------
export async function detectIsolation(cfg: RunnerConfig = {}): Promise<IsolationStatus> {
  const sandbox: IsolationStatus["sandbox"] = { available: false, tool: null, detail: "" };
  if (process.platform === "linux") {
    const bwrap = await which("bwrap");
    if (!bwrap) sandbox.detail = "bubblewrap não encontrado (instale o pacote `bubblewrap`)";
    else {
      const r = await run(bwrap, ["--die-with-parent", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], {
        timeoutMs: 10_000,
      });
      sandbox.available = r.code === 0;
      sandbox.tool = "bwrap";
      sandbox.path = path.resolve(bwrap);
      sandbox.detail = r.code === 0 ? `bubblewrap (${bwrap})` : `bubblewrap não funcionou: ${r.stderr.trim().slice(0, 200)} (namespaces de usuário desativados?)`;
    }
  } else if (process.platform === "darwin") {
    const se = await which("sandbox-exec");
    sandbox.available = !!se;
    sandbox.tool = se ? "sandbox-exec" : null;
    sandbox.path = se ? path.resolve(se) : null;
    sandbox.detail = se ? "Seatbelt (sandbox-exec) — caminho do macOS não testado" : "sandbox-exec não encontrado";
  } else {
    sandbox.detail = "sandbox do sistema indisponível nesta plataforma (no Windows, use o WSL2)";
  }

  const container: IsolationStatus["container"] = { available: false, runtime: null, detail: "" };
  const candidates: ("docker" | "podman")[] = cfg.container?.runtime ? [cfg.container.runtime] : ["docker", "podman"];
  const notes: string[] = [];
  for (const rt of candidates) {
    const bin = await which(rt);
    if (!bin) {
      notes.push(`${rt} não encontrado`);
      continue;
    }
    // O formato do `info` muda: o Docker tem .ServerVersion; o Podman, .Version.Version.
    const versionField = rt === "podman" ? "{{.Version.Version}}" : "{{.ServerVersion}}";
    const r = await run(bin, ["info", "--format", versionField], { timeoutMs: 15_000 });
    if (r.code === 0) {
      container.available = true;
      container.runtime = rt;
      container.path = path.resolve(bin);
      container.detail = `${rt} ${r.stdout.trim()}`;
      break;
    }
    notes.push(`${rt} instalado mas sem acesso ao serviço: ${r.stderr.trim().split("\n")[0]?.slice(0, 160) ?? ""}`);
  }
  if (!container.available) container.detail = notes.join("; ") || "nenhum runtime de container encontrado (Docker ou Podman)";
  return { sandbox, container };
}

// ---------- Montagem do comando ----------
export async function isolate(req: IsolationRequest, cfg: RunnerConfig, log: Logger, status?: IsolationStatus): Promise<IsolatedCommand> {
  switch (req.mode) {
    case "none":
      return { command: req.command, args: req.args, env: req.env, cwd: req.workdir };
    case "sandbox": {
      const tool = status?.sandbox.path ?? hostExecutable(process.platform === "darwin" ? "sandbox-exec" : "bwrap");
      if (process.platform === "darwin") return seatbelt(req, cfg, tool);
      return bubblewrap(req, cfg, tool);
    }
    case "container": {
      const st = status ?? (await detectIsolation(cfg));
      if (!st.container.runtime) throw new Error(`modo container indisponível: ${st.container.detail}`);
      return container(req, cfg, st.container.runtime, st.container.path ?? hostExecutable(st.container.runtime), log);
    }
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function uniq(list: string[]): string[] {
  return [...new Set(list.map((p) => path.resolve(p)))];
}

// ---------- Plano do sandbox (comum ao bubblewrap e ao Seatbelt) ----------
/** Pastas do sistema que continuam visíveis (somente leitura). Montagens dentro delas não são escondidas. */
const SYSTEM_DIRS = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/snap", "/nix", "/proc", "/sys", "/dev", "/boot", "/var/lib/snapd"];
/** Tipos de sistema de arquivos de discos externos, de rede ou do Windows (WSL). */
const EXTERNAL_FS = /^(9p|drvfs|cifs|smb3?|nfs4?|virtiofs|fuseblk|vfat|exfat|msdos|ntfs3?|hfsplus|apfs|udf|iso9660|sshfs|fuse\.(?!snapfuse).*)$/;

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Montagens que não são do sistema: discos externos, de rede, do Windows (/mnt/c no WSL)
 * ou outro disco montado fora das pastas do sistema. Lidas de /proc/self/mountinfo.
 */
export function externalMounts(mountinfo?: string): string[] {
  let text = mountinfo;
  if (text === undefined) {
    try {
      text = readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return [];
    }
  }
  const unescape = (x: string) => x.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  const rows = text
    .split("\n")
    .map((l) => {
      const parts = l.split(" ");
      const sep = parts.indexOf("-");
      if (sep < 0 || parts.length < sep + 3) return null;
      return { mount: unescape(parts[4]!), fstype: parts[sep + 1]!, source: unescape(parts[sep + 2]!) };
    })
    .filter((r): r is { mount: string; fstype: string; source: string } => !!r);
  const rootSource = rows.filter((r) => r.mount === "/").at(-1)?.source ?? null;
  const out: string[] = [];
  for (const r of rows) {
    if (r.mount === "/" || SYSTEM_DIRS.some((d) => within(r.mount, d))) continue;
    if (within(r.mount, "/tmp") || within(r.mount, "/var/tmp")) continue; // já são tmpfs novos
    const otherDisk = r.source.startsWith("/dev/") && r.source !== rootSource && !/^(tmpfs|devtmpfs|overlay|proc|sysfs)$/.test(r.fstype);
    if (EXTERNAL_FS.test(r.fstype) || otherDisk) out.push(r.mount);
  }
  return [...new Set(out)];
}

/** Procura um executável como o `which`, usando o PATH dado. */
export function resolveExecutable(cmd: string, pathEnv = process.env.PATH ?? ""): string | null {
  const ok = (p: string) => {
    try {
      accessSync(p, fsConstants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) return ok(cmd) ? path.resolve(cmd) : null;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (ok(p)) return p;
  }
  return null;
}

/** Segue os links simbólicos de um caminho: cada salto (link -> alvo) e o arquivo real. */
export function symlinkChain(p: string): { links: { link: string; target: string }[]; real: string } {
  const links: { link: string; target: string }[] = [];
  let cur = path.resolve(p);
  for (let i = 0; i < 40; i++) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      break;
    }
    if (!st.isSymbolicLink()) break;
    const target = readlinkSync(cur);
    links.push({ link: cur, target });
    cur = path.resolve(path.dirname(cur), target);
  }
  return { links, real: realOrResolved(cur) };
}

export interface SandboxPlan {
  /** Pastas escondidas por um tmpfs vazio (somente leitura no fim). */
  hiddenDirs: string[];
  /** Arquivos escondidos (trocados por /dev/null). */
  hiddenFiles: string[];
  /** Devolvidos somente leitura (depois de esconder). */
  readOnly: string[];
  /** Links simbólicos recriados dentro das pastas escondidas (ex.: ~/.local/bin/claude). */
  symlinks: { link: string; target: string }[];
  /** Escondidos de novo se uma pasta liberada os contiver (token do runner, chaves). */
  secrets: string[];
  /** Com escrita. */
  writable: string[];
  credentials: CredentialMount[];
  /**
   * Executáveis extras (comandos de conectores) recusados: ficam numa pasta escondida
   * (pasta pessoal, ~/.puxibot, /mnt...) fora do que a pessoa liberou. Não são montados.
   */
  rejected: { command: string; path: string }[];
}

/** Caminho que nunca pode ser liberado inteiro: a raiz, a pasta pessoal ou algo que contenha segredos. */
function tooBroad(p: string, secrets: string[]): boolean {
  if (p === "/") return true;
  const home = realOrResolved(os.homedir());
  if (within(home, p)) return true; // p é a pasta pessoal ou um ancestral dela
  return secrets.some((s) => within(s, p) && s !== p);
}

/**
 * O que esconder e o que devolver no modo sandbox. Puro (só lê o sistema de arquivos),
 * para ser testado sem bwrap.
 */
export function sandboxPlan(req: IsolationRequest, cfg: RunnerConfig, mountinfo?: string): SandboxPlan {
  const home = realOrResolved(os.homedir());
  const tbHome = realOrResolved(puxibotHome());
  const secrets = uniq([...defaultHiddenPaths(), ...(cfg.sandbox?.hidePaths ?? []).map(expandHome), tbHome].map(realOrResolved));

  const hiddenRoots = uniq([home, "/home", "/root", "/mnt", "/media", "/run/media", tbHome, ...externalMounts(mountinfo)]);
  if (process.platform === "darwin") hiddenRoots.push("/Users", "/Volumes");
  // /tmp e /var/tmp já são tmpfs novos dentro do sandbox.
  const fresh = ["/tmp", "/var/tmp"];
  const hiddenDirs: string[] = [];
  const hiddenFiles: string[] = [];
  const covered = (p: string, list: string[]) => list.some((d) => d !== p && within(p, d));
  for (const p of uniq([...hiddenRoots, ...secrets])) {
    if (!exists(p)) continue;
    // Já coberto por outra pasta escondida: não precisa (e não revela que existe).
    // A pasta pessoal fica mesmo assim, vazia, para existir dentro do sandbox.
    if (p !== home && covered(p, [...hiddenRoots.filter(exists), ...fresh])) continue;
    if (isDir(p)) hiddenDirs.push(p);
    else hiddenFiles.push(p);
  }
  const hiddenCover = (p: string) => [...hiddenDirs, ...fresh].some((d) => within(p, d)) || hiddenFiles.includes(p);

  // Executáveis: a CLI, o Node e os comandos extras, com os links simbólicos.
  const pathEnv = req.env.PATH ?? process.env.PATH ?? "";
  const exes = new Set<string>();
  for (const c of [req.command, "node"]) {
    const r = resolveExecutable(c, pathEnv);
    if (r) exes.add(r);
  }
  exes.add(process.execPath);
  const readOnly: string[] = [];
  const symlinks: { link: string; target: string }[] = [];
  for (const exe of exes) {
    const { links, real } = symlinkChain(exe);
    symlinks.push(...links);
    readOnly.push(executableRoot(real, secrets));
  }
  for (const p of selfMounts()) readOnly.push(tooBroad(p, secrets) ? path.join(p, "dist") : p);
  const writable = uniq([req.workdir, ...req.writable, ...(cfg.sandbox?.extraWritable ?? []).map(expandHome)].map(realOrResolved)).filter(exists);
  // Comandos de conectores vêm do hub: nunca liberam por conta própria algo escondido. Só
  // rodam se já estiverem visíveis: fora das pastas escondidas, dentro do que já é montado
  // para a CLI/Node/runner ou dentro de `sandbox.extraReadOnly`/`extraWritable`.
  const allowedRoots = uniq([...readOnly, ...(cfg.sandbox?.extraReadOnly ?? []).map(expandHome), ...writable].map(realOrResolved));
  const rejected: { command: string; path: string }[] = [];
  for (const c of req.executables ?? []) {
    const r = resolveExecutable(c, pathEnv);
    if (!r) continue;
    const { links, real } = symlinkChain(r);
    const hidden = hiddenCover(real) || secrets.some((s) => within(real, s));
    const allowed = !hidden || allowedRoots.some((d) => within(real, d));
    if (!allowed || secrets.some((s) => within(real, s))) {
      rejected.push({ command: c, path: real });
      continue;
    }
    symlinks.push(...links);
  }
  // Arquivos do sistema que são links para pastas escondidas (no WSL, /etc/resolv.conf ->
  // /mnt/wsl/resolv.conf: sem ele não há DNS).
  for (const f of systemFileLinks()) readOnly.push(f);
  for (const p of req.readable) readOnly.push(p);
  for (const p of cfg.sandbox?.extraReadOnly ?? []) readOnly.push(expandHome(p));

  const ro = uniq(readOnly.map(realOrResolved)).filter((p) => exists(p) && hiddenCover(p));
  const keptRo = ro.filter((p, i) => !ro.some((q, j) => j !== i && within(p, q) && q !== p));
  // Links: só os que ficam dentro de pastas escondidas e fora das devolvidas.
  const seen = new Set<string>();
  const keptLinks = symlinks.filter((l) => {
    if (seen.has(l.link) || !hiddenCover(l.link) || keptRo.some((d) => within(l.link, d))) return false;
    seen.add(l.link);
    return true;
  });
  const exposed = [...keptRo, ...writable];
  return {
    hiddenDirs,
    hiddenFiles,
    readOnly: keptRo,
    symlinks: keptLinks,
    secrets: secrets.filter((s) => exists(s) && exposed.some((d) => d !== s && within(s, d))),
    writable,
    credentials: req.credentials.filter((c) => exists(c.path)),
    rejected,
  };
}

/** Comandos de conectores que o sandbox recusaria (ver `SandboxPlan.rejected`). */
export function rejectedExecutables(req: IsolationRequest, cfg: RunnerConfig): { command: string; path: string }[] {
  return sandboxPlan(req, cfg).rejected;
}

/** Alvos reais (arquivos) de links simbólicos diretos em /etc. */
function systemFileLinks(): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync("/etc");
  } catch {
    return out;
  }
  for (const n of names) {
    const p = path.join("/etc", n);
    try {
      if (!lstatSync(p).isSymbolicLink()) continue;
      const real = realpathSync(p);
      if (statSync(real).isFile() && !SYSTEM_DIRS.some((d) => within(real, d))) out.push(real);
    } catch {
      /* link quebrado */
    }
  }
  return out;
}

/** O que liberar para um executável: o pacote npm dele, o prefixo do Node, ou só o arquivo. */
function executableRoot(real: string, secrets: string[]): string {
  const base = path.basename(real);
  const dir = path.dirname(real);
  if (/^node(\.exe)?$/.test(base) && path.basename(dir) === "bin") {
    const prefix = path.dirname(dir);
    if ((exists(path.join(prefix, "lib", "node_modules")) || exists(path.join(prefix, "include", "node"))) && !tooBroad(prefix, secrets)) {
      return prefix;
    }
    return real;
  }
  const pkg = packageDirOf(real);
  if (pkg && !tooBroad(pkg, secrets)) return pkg;
  return real;
}

/** Linux / WSL2: bubblewrap. */
export function bubblewrapArgs(req: IsolationRequest, cfg: RunnerConfig, mountinfo?: string): string[] {
  const plan = sandboxPlan(req, cfg, mountinfo);
  const a = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"];
  if (cfg.sandbox?.network === false) a.push("--unshare-net");
  a.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp");
  // 1. Esconde (pais antes dos filhos).
  const dirs = [...plan.hiddenDirs].sort((x, y) => x.length - y.length);
  for (const d of dirs) a.push("--tmpfs", d);
  for (const f of plan.hiddenFiles) a.push("--ro-bind", "/dev/null", f);
  // 2. Devolve o mínimo para executar, somente leitura.
  for (const p of plan.readOnly) a.push("--ro-bind", p, p);
  for (const l of plan.symlinks) a.push("--symlink", l.target, l.link);
  // 3. Pastas do job com escrita.
  for (const p of plan.writable) a.push("--bind", p, p);
  // 4. Segredos dentro de pastas liberadas continuam escondidos (ex.: extraReadOnly: ["~"])...
  for (const s of plan.secrets) {
    if (isDir(s)) a.push("--tmpfs", s);
    else a.push("--ro-bind", "/dev/null", s);
  }
  // ...menos as pastas do job que ficam dentro deles (a pasta de trabalho fica em ~/.puxibot).
  for (const p of plan.writable) if (plan.secrets.some((s) => s !== p && within(p, s))) a.push("--bind", p, p);
  // 5. Credenciais da CLI.
  for (const c of plan.credentials) a.push(c.writable ? "--bind" : "--ro-bind", c.path, c.path);
  // 6. As pastas escondidas ficam vazias e somente leitura (nada gravado nelas fica para trás).
  for (const d of [...dirs, ...plan.secrets.filter(isDir)]) a.push("--remount-ro", d);
  a.push("--chdir", req.workdir, "--", req.command, ...req.args);
  return a;
}

/** Variáveis para caches irem ao /tmp do sandbox (a pasta pessoal fica somente leitura). */
export function sandboxEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, XDG_CACHE_HOME: "/tmp/.cache", npm_config_cache: "/tmp/.npm" };
}

function bubblewrap(req: IsolationRequest, cfg: RunnerConfig, tool: string): IsolatedCommand {
  return { command: tool, args: bubblewrapArgs(req, cfg), env: sandboxEnv(req.env), cwd: req.workdir };
}

/**
 * macOS: Seatbelt (`sandbox-exec`). ESCRITO E NÃO TESTADO num Mac de verdade.
 * Mesmo plano do Linux: nega leitura do conteúdo da pasta pessoal, de /Users, /Volumes e
 * das pastas escondidas; libera o mínimo para executar; escrita só nas pastas do job e
 * temporários. Metadados (stat) continuam permitidos para a resolução de caminhos.
 * No Seatbelt a última regra que casa vence, por isso a ordem importa.
 */
export function seatbeltProfile(req: IsolationRequest, cfg: RunnerConfig): string {
  const plan = sandboxPlan(req, cfg, "");
  const q = (p: string) => JSON.stringify(realOrResolved(p));
  const sub = (list: string[]) => list.map((p) => `(subpath ${q(p)})`).join(" ");
  const lit = (list: string[]) => list.map((p) => `(literal ${q(p)})`).join(" ");
  const lines = ["(version 1)", "(allow default)"];
  if (plan.hiddenDirs.length || plan.hiddenFiles.length) {
    lines.push(`(deny file-read-data file-write* ${sub(plan.hiddenDirs)} ${lit(plan.hiddenFiles)})`);
  }
  const links = plan.symlinks.map((l) => l.link);
  if (plan.readOnly.length || links.length) lines.push(`(allow file-read-data ${sub(plan.readOnly)} ${lit(links)})`);
  if (plan.secrets.length) lines.push(`(deny file-read-data file-write* ${sub(plan.secrets)})`);
  lines.push("(deny file-write*)");
  const credR = plan.credentials.map((c) => c.path);
  const credW = plan.credentials.filter((c) => c.writable).map((c) => c.path);
  lines.push(`(allow file-read-data ${sub(plan.writable)} ${lit(credR)})`);
  lines.push(
    `(allow file-write* ${sub(plan.writable)} ${lit(credW)} (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))`,
  );
  if (cfg.sandbox?.network === false) lines.push("(deny network-outbound (remote ip))");
  return lines.join("\n");
}

function seatbelt(req: IsolationRequest, cfg: RunnerConfig, tool: string): IsolatedCommand {
  return {
    command: tool,
    args: ["-p", seatbeltProfile(req, cfg), req.command, ...req.args],
    env: req.env,
    cwd: req.workdir,
  };
}

// ---------- Container ----------
export const DOCKERFILE = path.join(packageRoot, "docker", "Dockerfile");

export function imageTag(npmPackage: string): string {
  const h = createHash("sha256").update(readFileSync(DOCKERFILE)).update(npmPackage).digest("hex").slice(0, 12);
  const name = npmPackage.replace(/^@/, "").replace(/[^a-z0-9]+/g, "-");
  return `puxibot-agent-${name}:${h}`;
}

/** Constrói a imagem do agente se ainda não existir. */
export async function ensureImage(runtime: string, npmPackage: string, log: Logger): Promise<string> {
  const tag = imageTag(npmPackage);
  const inspect = await run(runtime, ["image", "inspect", tag], { timeoutMs: 20_000 });
  if (inspect.code === 0) return tag;
  log.info(`construindo a imagem ${tag} (só na primeira vez; pode levar alguns minutos)...`);
  const b = await run(
    runtime,
    ["build", "-t", tag, "--build-arg", `CLI_PACKAGE=${npmPackage}`, "-f", DOCKERFILE, path.dirname(DOCKERFILE)],
    { timeoutMs: 20 * 60_000 },
  );
  if (b.code !== 0) throw new Error(`falha ao construir a imagem ${tag}: ${b.stderr.trim().split("\n").slice(-5).join("\n")}`);
  return tag;
}

export function containerName(jobId: string): string {
  return `puxibot-job-${jobId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60)}`;
}

export function containerArgs(req: IsolationRequest, cfg: RunnerConfig, runtime: "docker" | "podman", image: string): string[] {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const a = ["run", "--rm", "--init", "-i", "--name", containerName(req.jobId), "--user", `${uid}:${gid}`];
  if (runtime === "podman") a.push("--userns=keep-id");
  if (cfg.container?.network) a.push("--network", cfg.container.network);
  else if (req.hubIsLocal && process.platform === "linux") {
    // Hub local (wrangler dev): 127.0.0.1 dentro do container é o próprio container.
    a.push("--network", "host");
  }
  a.push("--tmpfs", "/tmp:rw,exec,mode=1777", "--workdir", req.workdir, "--security-opt", "no-new-privileges");
  const mounts = new Map<string, "ro" | "rw">();
  for (const p of selfMounts()) mounts.set(p, "ro");
  for (const p of req.readable) mounts.set(path.resolve(p), "ro");
  for (const p of [req.workdir, ...req.writable]) mounts.set(path.resolve(p), "rw");
  for (const c of req.credentials) mounts.set(c.path, c.writable ? "rw" : "ro");
  for (const [p, mode] of mounts) if (exists(p)) a.push("-v", `${p}:${p}:${mode}`);
  // Variáveis por nome: o valor vem do ambiente do processo do docker, não do argv.
  a.push("-e", "HOME=/tmp");
  for (const k of Object.keys(req.env)) {
    if (CONTAINER_ENV_SKIP.has(k)) continue;
    a.push("-e", k);
  }
  a.push(image, req.command, ...req.args);
  return a;
}

/** Variáveis do host que não fazem sentido dentro do container. */
const CONTAINER_ENV_SKIP = new Set(["PATH", "HOME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "NODE_OPTIONS", "NVM_DIR", "NVM_BIN", "LD_LIBRARY_PATH"]);

async function container(req: IsolationRequest, cfg: RunnerConfig, runtime: "docker" | "podman", bin: string, log: Logger): Promise<IsolatedCommand> {
  const image = cfg.container?.image ?? req.image;
  if (!image) throw new Error("imagem de container não definida");
  return {
    command: bin,
    args: containerArgs(req, cfg, runtime, image),
    env: req.env,
    cwd: req.workdir,
    kill: async () => {
      const r = await run(bin, ["kill", containerName(req.jobId)], { timeoutMs: 15_000 });
      if (r.code !== 0) log.debug(`${runtime} kill: ${r.stderr.trim()}`);
    },
  };
}

export function isolationWarning(mode: IsolationMode): string | null {
  if (mode === "none") {
    return "ATENÇÃO: isolamento desligado (--isolation none). Os agentes rodam com o seu usuário e podem ler e alterar qualquer arquivo que você pode. Use só para testes; prefira `sandbox` ou `container`.";
  }
  return null;
}

