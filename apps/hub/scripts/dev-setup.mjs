#!/usr/bin/env node
// Prepara o ambiente local do hub sem configuração manual:
// 1. cria apps/hub/.dev.vars com segredos de desenvolvimento aleatórios (se não existir);
// 2. cria um placeholder em apps/web/dist se a interface ainda não foi compilada,
//    porque o `wrangler dev` exige que o diretório de assets exista.
// Em produção, defina os segredos com `wrangler secret put JOB_TOKEN_SECRET` e `wrangler secret put SECRETS_KEY`.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const devVars = join(hubDir, ".dev.vars");
if (!existsSync(devVars)) {
  const content = [
    "# Gerado por scripts/dev-setup.mjs. Só para desenvolvimento local; não use em produção.",
    `JOB_TOKEN_SECRET=${randomBytes(32).toString("hex")}`,
    `SECRETS_KEY=${randomBytes(32).toString("base64")}`,
    "",
  ].join("\n");
  writeFileSync(devVars, content, { mode: 0o600 });
  console.log("[puxibot] .dev.vars criado com segredos de desenvolvimento.");
}

const webDist = join(hubDir, "..", "web", "dist");
if (!existsSync(webDist)) {
  mkdirSync(webDist, { recursive: true });
  writeFileSync(
    join(webDist, "index.html"),
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Puxibot</title></head>' +
      "<body><p>A interface web ainda não foi compilada. Rode <code>npm run build -w @puxibot/web</code>.</p></body></html>\n",
  );
  console.log("[puxibot] apps/web/dist não existia; placeholder criado.");
}
