/**
 * Plano do agente criador: a estrutura que ele propõe a partir da conversa (canais, agentes, skills,
 * rotinas, páginas da wiki, memórias do time e conectores necessários). O agente só propõe; quem cria
 * é o hub, de uma vez, depois que a pessoa revisa e aprova.
 */
import { z } from "zod";

const handle = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "use minúsculas, números, - ou _");
const channelName = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "nome de canal: minúsculas, números, - ou _");

export const SETUP_LIMITS = { channels: 12, agents: 10, skills: 12, routines: 12, wikiPages: 10, memories: 12, connectors: 10 } as const;

export const setupPlanSchema = z.object({
  /** Uma ou duas frases: o que esta estrutura resolve. */
  summary: z.string().trim().min(1).max(600),
  channels: z
    .array(z.object({ name: channelName, section: z.string().trim().max(40).optional(), topic: z.string().trim().max(200).optional() }))
    .max(SETUP_LIMITS.channels)
    .default([]),
  agents: z
    .array(
      z.object({
        handle,
        name: z.string().trim().min(1).max(60),
        role: z.string().trim().max(60).optional(),
        description: z.string().trim().max(500).optional(),
        instructions: z.string().trim().min(1).max(8000),
        /** Canais (pelo nome) em que o agente entra. */
        channels: z.array(channelName).max(8).default([]),
        /** Conectores de que precisa: `catalogId` do catálogo ou o `name` de um conector personalizado deste plano. */
        connectors: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
        /** Skills deste plano (pelo nome) que o agente usa. */
        skills: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
      }),
    )
    .max(SETUP_LIMITS.agents)
    .default([]),
  skills: z
    .array(z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).default(""), body: z.string().trim().min(1).max(4000) }))
    .max(SETUP_LIMITS.skills)
    .default([]),
  routines: z
    .array(
      z.object({
        agent: handle,
        name: z.string().trim().min(1).max(100),
        prompt: z.string().trim().min(1).max(4000),
        cron: z.string().trim().min(1).max(120),
        timezone: z.string().trim().min(1).max(64).optional(),
        channel: channelName.optional(),
      }),
    )
    .max(SETUP_LIMITS.routines)
    .default([]),
  wikiPages: z
    .array(z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(8000) }))
    .max(SETUP_LIMITS.wikiPages)
    .default([]),
  /** Fatos do time que a pessoa disse na conversa. */
  memories: z.array(z.string().trim().min(1).max(500)).max(SETUP_LIMITS.memories).default([]),
  connectors: z
    .array(
      z.object({
        /** Id de um app do catálogo. Sem ele, é um conector personalizado (a pessoa informa o endereço). */
        catalogId: z.string().trim().max(40).optional(),
        name: z.string().trim().min(1).max(80),
        /** Para que os agentes vão usar este serviço. */
        reason: z.string().trim().min(1).max(300),
      }),
    )
    .max(SETUP_LIMITS.connectors)
    .default([]),
});
export type SetupPlan = z.output<typeof setupPlanSchema>;

/** Resultado de aplicar um plano. */
export interface SetupApplyResult {
  created: { channels: string[]; agents: string[]; skills: string[]; routines: string[]; wikiPages: string[]; memories: number };
  /** O que já existia (mesmo nome) ou não pôde ser criado, com o motivo. Nada existente é alterado. */
  skipped: { kind: "channel" | "agent" | "skill" | "routine" | "wikiPage" | "memory"; name: string; reason: string }[];
  /** Conexões que a pessoa ainda precisa fazer, e que agentes esperam por elas. */
  pendingConnectors: { catalogId: string | null; name: string; reason: string; agentIds: string[]; agentNames: string[]; connectorId: string | null }[];
}

export interface SetupPlanDTO {
  id: string;
  status: "draft" | "applied" | "discarded";
  plan: SetupPlan;
  result: SetupApplyResult | null;
  createdAt: number;
  updatedAt: number;
}

/** GET/POST /setup/session */
export interface SetupSessionDTO {
  agentId: string;
  channelId: string;
  plan: SetupPlanDTO | null;
}
