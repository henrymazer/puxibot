import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Roda antes de cada arquivo de teste; aplica só o que ainda não foi aplicado.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
