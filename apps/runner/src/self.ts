/**
 * Como iniciar o próprio `puxibot` (para o `puxibot mcp` que a CLI de IA sobe).
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do pacote @puxibot/runner (pai de src/ ou dist/). */
export const packageRoot = path.resolve(here, "..");

export interface SelfCommand {
  command: string;
  args: string[];
}

/** Comando para rodar `puxibot` no host. */
export function selfCommand(): SelfCommand {
  const override = process.env.PUXIBOT_SELF_CMD;
  if (override) {
    const arr = JSON.parse(override) as string[];
    return { command: arr[0]!, args: arr.slice(1) };
  }
  const dist = distBundle();
  if (dist) return { command: process.execPath, args: [dist] };
  // Desenvolvimento sem build: tsx com caminho absoluto (o cwd da CLI é outro).
  const tsx = import.meta.resolve("tsx");
  return { command: process.execPath, args: ["--import", tsx, path.join(packageRoot, "src", "cli.ts")] };
}

/** Comando dentro do container: o `node` da imagem e o dist montado no mesmo caminho. */
export function selfCommandInContainer(): SelfCommand {
  const dist = path.join(packageRoot, "dist", "cli.js");
  if (!existsSync(dist)) {
    throw new Error("o modo container precisa do runner compilado (rode `npm run build -w @puxibot/runner`)");
  }
  return { command: "node", args: [dist] };
}

/** O dist é um único arquivo com todas as dependências (gerado por scripts/build.mjs). */
export function distBundle(): string | null {
  const dist = path.join(packageRoot, "dist", "cli.js");
  return existsSync(dist) ? dist : null;
}

/**
 * Pastas que precisam estar visíveis (somente leitura) no sandbox e no container para o
 * `puxibot mcp` funcionar. Com o runner compilado basta a pasta do pacote (o dist traz
 * todas as dependências). Sem build (desenvolvimento com tsx), também as pastas
 * node_modules de onde vêm as dependências e o código de @puxibot/shared.
 */
export function selfMounts(): string[] {
  const roots = new Set<string>([packageRoot]);
  if (!distBundle()) {
    for (const dep of ["@modelcontextprotocol/sdk", "zod", "commander", "ws", "tsx", "@puxibot/shared"]) {
      try {
        const file = realpathSync(fileURLToPath(import.meta.resolve(dep)));
        const idx = file.lastIndexOf(`${path.sep}node_modules${path.sep}`);
        if (idx > 0) roots.add(file.slice(0, idx + "/node_modules".length));
        else roots.add(packageDirOf(file) ?? path.dirname(file));
      } catch {
        /* ignora */
      }
    }
  }
  // Remove pastas contidas em outras.
  const list = [...roots].sort((a, b) => a.length - b.length);
  return list.filter((p, i) => !list.slice(0, i).some((q) => p === q || p.startsWith(q + path.sep)));
}

/** Pasta do pacote npm (com package.json) que contém o arquivo, subindo até 6 níveis. */
export function packageDirOf(file: string): string | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
