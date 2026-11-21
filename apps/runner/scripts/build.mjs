#!/usr/bin/env node
// Gera dist/cli.js: um único arquivo ESM com o runner e todas as dependências
// (inclusive o código de @puxibot/shared). Assim o pacote instalado não depende do
// workspace, e o sandbox/container só precisam enxergar a pasta do pacote.
import { chmodSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "dist", "cli.js");

rmSync(path.join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Dependências CJS (commander, ws) usam require(); no ESM ele vem do createRequire.
  banner: {
    js: [
      'import { createRequire as __puxibotCreateRequire } from "node:module";',
      "const require = __puxibotCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __PUXIBOT_VERSION__: JSON.stringify(pkg.version) },
  // Opcionais do `ws` (aceleração nativa); sem eles o ws usa JavaScript puro.
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(out, 0o755);
console.log(`dist/cli.js gerado (puxibot ${pkg.version})`);
