import type { ClientEvent } from "@puxibot/shared";
import type { AppEnv } from "../env";

/** Quem está conectado agora ao `WorkspaceHub` (navegadores e runners). */
export interface Presence {
  onlineUserIds: string[];
  runners: { runnerId: string; userId: string }[];
}

/**
 * Ponte com o Durable Object do workspace. Nas rotas HTTP é implementada por RPC no stub
 * (`workerRealtime`); dentro do próprio DO, por chamadas diretas — assim as funções de domínio
 * funcionam nos dois lados sem o DO chamar a si mesmo.
 */
export interface Realtime {
  /** Envia o evento aos navegadores conectados. `audience = null`: todos os membros do workspace. */
  publish(event: ClientEvent, audience: string[] | null): Promise<void>;
  /** Reavalia a fila de jobs (entrega jobs `queued` a runners livres). */
  pump(): Promise<void>;
  presence(): Promise<Presence>;
  /** Avisa o runner que está com o job para parar (`job.cancel`). */
  cancelOnRunner(jobId: string, runnerId: string): Promise<void>;
  /** Fecha as conexões de um runner removido. */
  disconnectRunner(runnerId: string): Promise<void>;
  /** Fecha as conexões de uma pessoa que saiu do workspace. */
  disconnectUser(userId: string): Promise<void>;
}

/** Contexto de domínio: tudo que as funções de `src/domain` precisam. */
export interface HubCtx {
  env: AppEnv;
  wsId: string;
  rt: Realtime;
}

export function hubStub(env: AppEnv, wsId: string) {
  return env.WORKSPACE_HUB.getByName(wsId);
}

export function workerRealtime(env: AppEnv, wsId: string): Realtime {
  const stub = () => hubStub(env, wsId);
  return {
    publish: async (event, audience) => {
      await stub().publish(wsId, event, audience);
    },
    pump: async () => {
      await stub().pump(wsId);
    },
    presence: async () => stub().presence(wsId),
    cancelOnRunner: async (jobId, runnerId) => {
      await stub().cancelOnRunner(wsId, jobId, runnerId);
    },
    disconnectRunner: async (runnerId) => {
      await stub().disconnectRunner(wsId, runnerId);
    },
    disconnectUser: async (userId) => {
      await stub().disconnectUser(wsId, userId);
    },
  };
}

export function workerCtx(env: AppEnv, wsId: string): HubCtx {
  return { env, wsId, rt: workerRealtime(env, wsId) };
}
