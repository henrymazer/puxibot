declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    // Definidos só no vitest.config.ts (opcionais em produção).
    VAPID_PUBLIC_KEY: string;
    VAPID_PRIVATE_KEY: string;
    TELEGRAM_BOT_TOKEN: string;
  }
}
