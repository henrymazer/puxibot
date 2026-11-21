import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Os testes reais com o Claude Code demoram; só rodam com PUXIBOT_LIVE=1.
    pool: "forks",
  },
});
