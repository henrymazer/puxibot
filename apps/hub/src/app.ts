import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorBody, HttpError } from "./lib/errors";
import { identify, requireJob, requireMember } from "./http/auth";
import { apiSecurityHeaders, originCheck, requireStrongSecrets } from "./http/security";
import type { BaseApp, BaseEnv, ToolApp, ToolEnv, WsApp, WsEnv } from "./http/types";
import { agentRoutes } from "./routes/agents";
import { authRoutes } from "./routes/auth";
import { channelRoutes } from "./routes/channels";
import { inviteRoutes, workspaceInviteRoutes } from "./routes/invites";
import { jobRoutes } from "./routes/jobs";
import { notificationRoutes } from "./routes/notifications";
import { realtimeRoutes } from "./routes/realtime";
import { pairingRoutes, tokenRoutes } from "./routes/tokens";
import { workspaceCreateRoutes, workspaceRoutes } from "./routes/workspaces";
import { accountRoutes } from "./routes/account";
import { fileRoutes } from "./routes/files";
import { knowledgeRoutes } from "./routes/knowledge";
import { mcpRoutes } from "./routes/mcp";
import { miscRoutes } from "./routes/misc";
import { routineRoutes } from "./routes/routines";
import { taskRoutes } from "./routes/tasks";
import { toolRoutes } from "./routes/tool";
import { extraRoutes, vaultToolRoutes } from "./routes/extras";
import { setupRoutes, setupToolRoutes } from "./routes/setup";
import { trustRoutes } from "./routes/trust";
import { wikiRoutes } from "./routes/wiki";
import { registerDeliveries } from "./domain/deliveries";

// Web Push e Telegram entram como canais extras de `notify()`.
registerDeliveries();

/**
 * Registro de rotas. Para um domínio novo, crie `src/routes/<dominio>.ts` exportando um `new Hono<...>()`
 * com caminhos relativos e acrescente-o à lista certa:
 * - `publicRouters`: montados em `/api` (auth própria por rota);
 * - `workspaceRouters`: montados em `/api/workspaces/:ws`, já com `requireMember` (c.var.userId, wsId, member, hub);
 * - `toolRouters`: montados em `/api/tool`, já com `requireJob` (c.var.job, hub).
 */
const publicRouters: BaseApp[] = [authRoutes, inviteRoutes, pairingRoutes, workspaceCreateRoutes, accountRoutes];
const workspaceRouters: WsApp[] = [
  workspaceRoutes,
  workspaceInviteRoutes,
  tokenRoutes,
  realtimeRoutes,
  channelRoutes,
  agentRoutes,
  jobRoutes,
  notificationRoutes,
  taskRoutes,
  wikiRoutes,
  fileRoutes,
  knowledgeRoutes,
  routineRoutes,
  miscRoutes,
  mcpRoutes,
  trustRoutes,
  setupRoutes,
  extraRoutes,
];
const toolRouters: ToolApp[] = [toolRoutes, setupToolRoutes, vaultToolRoutes];

export function buildApp(): Hono<BaseEnv> {
  const app = new Hono<BaseEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status);
    if (err instanceof HTTPException) {
      return c.json(errorBody("http_error", err.message || "Requisição inválida."), err.status);
    }
    console.error(JSON.stringify({ msg: "unhandled error", path: new URL(c.req.url).pathname, error: String(err), stack: (err as Error)?.stack }));
    return c.json(errorBody("internal", "Erro interno no hub. Tente de novo."), 500);
  });

  app.use("/api/*", apiSecurityHeaders);
  app.use("/api/*", requireStrongSecrets);
  app.use("/api/*", originCheck);
  app.use("/api/*", identify);

  const api = new Hono<BaseEnv>();
  for (const r of publicRouters) api.route("/", r);

  const ws = new Hono<WsEnv>();
  ws.use("*", requireMember);
  for (const r of workspaceRouters) ws.route("/", r);
  api.route("/workspaces/:ws", ws as unknown as Hono<BaseEnv>);

  const tool = new Hono<ToolEnv>();
  tool.use("*", requireJob);
  for (const r of toolRouters) tool.route("/", r);
  api.route("/tool", tool as unknown as Hono<BaseEnv>);

  app.route("/api", api);

  app.all("/api/*", (c) => c.json(errorBody("not_found", "Rota não encontrada."), 404));
  // Fora de /api: interface web (normalmente servida direto pelos assets; aqui só se o Worker for chamado).
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}
