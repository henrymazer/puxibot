/**
 * A biblioteca do WhatsApp (Baileys, a mesma que o Nod usa) não vai dentro do pacote do runner: é grande
 * e só interessa a quem liga o WhatsApp. Ela é instalada sob demanda numa pasta própria, numa versão
 * fixa, sem rodar scripts de instalação, e carregada de lá.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { puxibotHome } from "../config.js";
import type { WaLib } from "./channel.js";

export const BAILEYS_PACKAGE = "@whiskeysockets/baileys";
/** Mesma versão fixada pelo Nod (n8n-io/nod, package.json). */
export const BAILEYS_VERSION = "7.0.0-rc14";

export const whatsappPaths = {
  root: () => path.join(puxibotHome(), "whatsapp"),
  lib: () => path.join(puxibotHome(), "whatsapp", "lib"),
  session: () => path.join(puxibotHome(), "whatsapp", "session"),
};

function packageDir(): string {
  return path.join(whatsappPaths.lib(), "node_modules", ...BAILEYS_PACKAGE.split("/"));
}

export function baileysInstalled(): boolean {
  try {
    return (JSON.parse(readFileSync(path.join(packageDir(), "package.json"), "utf8")) as { version?: string }).version === BAILEYS_VERSION;
  } catch {
    return false;
  }
}

/** `npm install` na pasta própria. Devolve quando termina; lança com o fim da saída do npm se falhar. */
export async function installBaileys(onLine: (line: string) => void = () => {}): Promise<void> {
  const dir = whatsappPaths.lib();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path.join(dir, "package.json"))) writeFileSync(path.join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n", { mode: 0o600 });
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--save-exact", `${BAILEYS_PACKAGE}@${BAILEYS_VERSION}`];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (b: Buffer) => {
      const text = b.toString("utf8");
      tail = (tail + text).slice(-2000);
      for (const line of text.split("\n")) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => reject(new Error(`não consegui rodar o npm: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`o npm terminou com erro (${code}): ${tail.trim().split("\n").slice(-3).join(" | ")}`))));
  });
  if (!baileysInstalled()) throw new Error("a biblioteca do WhatsApp não ficou instalada na versão esperada");
}

export async function loadBaileys(): Promise<WaLib> {
  if (!baileysInstalled()) throw new Error("a biblioteca do WhatsApp não está instalada. Rode `puxibot whatsapp conectar`.");
  const pkg = JSON.parse(readFileSync(path.join(packageDir(), "package.json"), "utf8")) as { main?: string };
  const mod = (await import(pathToFileURL(path.join(packageDir(), pkg.main ?? "lib/index.js")).href)) as Record<string, unknown>;
  const makeWASocket = (typeof mod.makeWASocket === "function" ? mod.makeWASocket : mod.default) as WaLib["makeWASocket"];
  if (typeof makeWASocket !== "function") throw new Error("a biblioteca do WhatsApp instalada não tem o formato esperado");
  return { ...(mod as unknown as WaLib), makeWASocket };
}
