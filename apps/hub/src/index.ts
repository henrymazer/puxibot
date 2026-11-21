import { buildApp } from "./app";
import type { AppEnv } from "./env";
import { wakeRoutineHubs } from "./domain/routines";
import { pruneRateLimits } from "./lib/rateLimit";

export { WorkspaceHub } from "./do/WorkspaceHub";

const app = buildApp();

/** Limpeza periódica: janelas de limite de tentativas e pareamentos vencidos. */
async function housekeeping(env: AppEnv): Promise<void> {
  await pruneRateLimits(env.DB);
  await env.DB.prepare("DELETE FROM runner_pairings WHERE expires_at <= ?").bind(Date.now()).run();
}

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // Cron de segurança: corrige rotinas sem próximo horário e acorda o WorkspaceHub de quem tem rotina vencida
  // ou perto de vencer (o alarme do DO é o mecanismo principal; isto cobre DOs que nunca foram acordados).
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(wakeRoutineHubs(env));
    ctx.waitUntil(
      housekeeping(env).catch((err) => console.error(JSON.stringify({ msg: "housekeeping failed", error: String(err) }))),
    );
  },
} satisfies ExportedHandler<AppEnv>;
