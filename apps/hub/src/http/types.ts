import type { Hono } from "hono";
import type { AppEnv } from "../env";
import type { HubCtx } from "../domain/context";
import type { MemberRow } from "../domain/rows";
import type { JobTokenClaims } from "../lib/jobToken";

export type AuthInfo =
  | { kind: "session"; userId: string; sessionId: string }
  | { kind: "token"; userId: string; tokenId: string; tokenKind: "personal" | "runner"; workspaceId: string };

/** Variáveis das rotas públicas (/api/auth, /api/me, /api/invites, /api/runner/pair...). */
export interface BaseVars {
  auth: AuthInfo | null;
}

/** Variáveis das rotas sob /api/workspaces/:ws (preenchidas por `requireMember`). */
export interface WsVars extends BaseVars {
  auth: AuthInfo;
  userId: string;
  wsId: string;
  member: MemberRow;
  /** Contexto de domínio já ligado ao DO do workspace. */
  hub: HubCtx;
}

/** Variáveis das rotas /api/tool/* (preenchidas por `requireJob`). */
export interface ToolVars extends BaseVars {
  job: JobTokenClaims & { requestedByUserId: string | null; agentOwnerUserId: string };
  hub: HubCtx;
}

export type BaseEnv = { Bindings: AppEnv; Variables: BaseVars };
export type WsEnv = { Bindings: AppEnv; Variables: WsVars };
export type ToolEnv = { Bindings: AppEnv; Variables: ToolVars };

export type BaseApp = Hono<BaseEnv>;
export type WsApp = Hono<WsEnv>;
export type ToolApp = Hono<ToolEnv>;
