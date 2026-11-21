#!/usr/bin/env node
// Gera um par de chaves VAPID (P-256) para o Web Push do hub.
// Uso: npm run vapid -w @puxibot/hub
// Depois: `wrangler secret put VAPID_PUBLIC_KEY`, `wrangler secret put VAPID_PRIVATE_KEY` e (opcional)
// `wrangler secret put VAPID_SUBJECT` (ex.: mailto:voce@empresa.com). Em dev, cole as linhas em apps/hub/.dev.vars.
import { webcrypto } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicRaw = await webcrypto.subtle.exportKey("raw", pair.publicKey); // 65 bytes, não comprimido
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);

console.log(`VAPID_PUBLIC_KEY=${b64url(publicRaw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log("VAPID_SUBJECT=mailto:admin@seu-dominio.com");
