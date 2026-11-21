#!/usr/bin/env node
// Coloca o pacote do runner dentro da interface web, para o próprio hub servi-lo em
// /instalar/puxibot-runner.tgz. Assim cada pessoa instala o runner com um comando só,
// direto do hub do time, na mesma versão do hub, sem precisar do repositório:
//   npm install -g https://<hub>/instalar/puxibot-runner.tgz
// Roda antes do build e do dev da interface (apps/web/package.json).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "apps", "runner");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args) => execFileSync(npm, args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });

run(["run", "build", "-w", "@puxibot/runner"]);
run(["run", "pack", "-w", "@puxibot/runner"]);
const { version } = JSON.parse(readFileSync(join(runner, "package.json"), "utf8"));
const outDir = join(root, "apps", "web", "public", "instalar");
mkdirSync(outDir, { recursive: true });
copyFileSync(join(runner, `puxibot-runner-${version}.tgz`), join(outDir, "puxibot-runner.tgz"));
console.log(`runner ${version} incluído na interface: /instalar/puxibot-runner.tgz`);
