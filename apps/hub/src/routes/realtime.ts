import { Hono } from "hono";
import { HttpError, forbidden } from "../lib/errors";
import type { WsEnv } from "../http/types";
import { hubStub } from "../domain/context";
import { HUB_HEADERS } from "../do/WorkspaceHub";

/** WebSockets: /api/workspaces/:ws/realtime (navegador) e /runner (runner). Ambos terminam no WorkspaceHub. */
export const realtimeRoutes = new Hono<WsEnv>();

function forward(c: import("hono").Context<WsEnv>, kind: "browser" | "runner", tokenId: string | null) {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "upgrade_required", "Esta rota só aceita WebSocket.");
  }
  const headers = new Headers(c.req.raw.headers);
  // Nunca confiar em cabeçalhos internos vindos do cliente.
  for (const h of Object.values(HUB_HEADERS)) headers.delete(h);
  headers.set(HUB_HEADERS.kind, kind);
  headers.set(HUB_HEADERS.user, c.get("userId"));
  headers.set(HUB_HEADERS.workspace, c.get("wsId"));
  headers.set(HUB_HEADERS.origin, new URL(c.req.url).origin);
  if (tokenId) headers.set(HUB_HEADERS.token, tokenId);
  return hubStub(c.env, c.get("wsId")).fetch(new Request(c.req.url, { method: "GET", headers }));
}

realtimeRoutes.get("/realtime", (c) => {
  const auth = c.get("auth");
  if (auth.kind === "token" && auth.tokenKind === "runner") throw forbidden("Use a rota /runner com token de runner.");
  return forward(c, "browser", null);
});

realtimeRoutes.get("/runner", (c) => {
  const auth = c.get("auth");
  if (auth.kind !== "token" || auth.tokenKind !== "runner") {
    throw forbidden("A conexão do runner exige um token de runner (Authorization: Bearer tb_...).", "runner_token_required");
  }
  return forward(c, "runner", auth.tokenId);
});
