#!/usr/bin/env node
// Ambiente de desenvolvimento: prepara o hub (segredos locais e migrações do D1 local) e sobe
// o hub (wrangler dev) e a interface (Vite) juntos, com recarga automática. Ctrl+C encerra os dois.
//
//   npm run dev
//   HUB_PORT=8790 WEB_PORT=5180 npm run dev    # portas fixas
//
// Sem HUB_PORT/WEB_PORT, usa 8787 e 5173, ou a próxima porta livre se estiverem ocupadas.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hubDir = join(root, "apps", "hub");
const webDir = join(root, "apps", "web");
const bin = (name) => join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

function portFree(port) {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    // Sem host: testa todas as interfaces (IPv4 e IPv6), como o wrangler e o Vite usam.
    s.listen(port, () => s.close(() => ok(true)));
  });
}

async function pickPort(envName, preferred) {
  const fixed = process.env[envName];
  if (fixed) {
    const n = Number(fixed);
    if (!(await portFree(n))) throw new Error(`a porta ${n} (${envName}) está ocupada`);
    return n;
  }
  for (let p = preferred; p < preferred + 50; p++) if (await portFree(p)) return p;
  throw new Error(`nenhuma porta livre entre ${preferred} e ${preferred + 49}`);
}

function runOnce(cmd, args, cwd) {
  return new Promise((ok, ko) => {
    const c = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    c.on("error", ko);
    c.on("close", (code) => (code === 0 ? ok() : ko(new Error(`${cmd} ${args.join(" ")} terminou com código ${code}`))));
  });
}

const children = [];
let stopping = false;

function prefixLines(tag, stream, out) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) out.write(`${tag} ${l}\n`);
  });
  stream.on("end", () => buf && out.write(`${tag} ${buf}\n`));
}

function start(tag, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Grupo de processos próprio: no encerramento matamos o grupo inteiro (workerd, esbuild...).
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });
  prefixLines(tag, child.stdout, process.stdout);
  prefixLines(tag, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[dev] ${tag.trim()} saiu (${signal ?? `código ${code}`}); encerrando o resto.`);
      stop(code || 1);
    }
  });
  children.push(child);
  return child;
}

function killTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* já saiu */
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) killTree(c, "SIGTERM");
  const force = setTimeout(() => {
    for (const c of children) killTree(c, "SIGKILL");
  }, 5000);
  force.unref();
  Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() => {
    clearTimeout(force);
    process.exit(code);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function main() {
  if (!existsSync(bin("wrangler"))) throw new Error("dependências não instaladas. Rode `npm install` na raiz do repositório.");
  const hubPort = await pickPort("HUB_PORT", 8787);
  const webPort = await pickPort("WEB_PORT", 5173);

  console.log("[dev] Preparando o hub: segredos locais (.dev.vars) e migrações do D1 local...");
  // O mesmo que `npm run db:migrate -w @puxibot/hub`, sem a pergunta de confirmação.
  await runOnce(process.execPath, [join(hubDir, "scripts", "dev-setup.mjs")], hubDir);
  await runOnce(bin("wrangler"), ["d1", "migrations", "apply", "puxibot", "--local", "--force"], hubDir);

  console.log(`[dev] Hub em http://localhost:${hubPort} · interface em http://localhost:${webPort} (abra esta)`);
  console.log("[dev] Ctrl+C encerra os dois.");
  start("[hub]", bin("wrangler"), ["dev", "--port", String(hubPort)], hubDir);
  start("[web]", process.execPath, [join(root, "scripts", "lib", "vite-dev.mjs")], webDir, {
    HUB_PORT: String(hubPort),
    WEB_PORT: String(webPort),
  });
}

main().catch((e) => {
  console.error(`[dev] Erro: ${e instanceof Error ? e.message : String(e)}`);
  stop(1);
  if (!children.length) process.exit(1);
});
