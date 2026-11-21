import { randomBytes, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
// Garante apps/web/dist (assets) e .dev.vars antes de o Miniflare ler o wrangler.jsonc.
import "./scripts/dev-setup.mjs";

const b64url = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64url");

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  // Chaves geradas a cada execução: nada com cara de segredo fica versionado.
  const vapid = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapidPublic = b64url(await webcrypto.subtle.exportKey("raw", vapid.publicKey));
  const vapidPrivate = (await webcrypto.subtle.exportKey("jwk", vapid.privateKey)).d!;
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            JOB_TOKEN_SECRET: "test-job-token-secret",
            SECRETS_KEY: randomBytes(32).toString("base64"),
            PUBLIC_URL: "",
            // Os testes criam muitas contas sem convite; o modo fechado é testado à parte (auth.test.ts).
            OPEN_SIGNUP: "true",
            VAPID_PUBLIC_KEY: vapidPublic,
            VAPID_PRIVATE_KEY: vapidPrivate,
            VAPID_SUBJECT: "mailto:testes@puxibot.local",
            TELEGRAM_BOT_TOKEN: "123:test-token",
            TELEGRAM_WEBHOOK_SECRET: "segredo-do-webhook",
            TELEGRAM_BOT_USERNAME: "puxibot_teste_bot",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 30_000,
    },
  };
});
