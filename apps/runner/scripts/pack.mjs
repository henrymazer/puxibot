#!/usr/bin/env node
// Monta o pacote npm instalável `puxibot-runner` (binário `puxibot`) e gera o tarball
// com `npm pack`, sem publicar nada:
//   npm run pack -w @puxibot/runner   ->  apps/runner/puxibot-runner-<versão>.tgz
//   npm install -g ./apps/runner/puxibot-runner-<versão>.tgz
// O nome do workspace continua @puxibot/runner (os scripts da raiz usam esse nome);
// o pacote gerado tem nome próprio, sem dependências (tudo vai no dist/cli.js).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..", "..");
const src = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (!existsSync(path.join(root, "dist", "cli.js"))) {
  console.error("rode `npm run build -w @puxibot/runner` antes");
  process.exit(1);
}

const stage = mkdtempSync(path.join(os.tmpdir(), "puxibot-runner-pack-"));
try {
  const pkg = {
    name: "puxibot-runner",
    version: src.version,
    description: "Runner do Puxibot: executa os agentes do seu time na sua máquina, com a CLI de IA que você já usa (Claude Code, Codex, Gemini CLI), dentro de um isolamento.",
    license: "MIT",
    type: "module",
    bin: { puxibot: "dist/cli.js" },
    files: ["dist", "docker"],
    engines: { node: ">=22" },
    os: ["linux", "darwin"],
    keywords: ["puxibot", "agents", "claude-code", "codex", "gemini-cli", "mcp"],
  };
  writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  cpSync(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });
  cpSync(path.join(root, "docker"), path.join(stage, "docker"), { recursive: true });
  for (const f of ["LICENSE", "LICENSE.md"]) {
    if (existsSync(path.join(repo, f))) cpSync(path.join(repo, f), path.join(stage, f));
  }
  const out = execFileSync("npm", ["pack", "--pack-destination", root], { cwd: stage, encoding: "utf8" }).trim().split("\n").at(-1);
  console.log(`pacote gerado: ${path.join(root, out ?? "")}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
