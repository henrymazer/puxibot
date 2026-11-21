import { extractMentions, type MessageDTO } from "@puxibot/shared";
import type { AppEnv } from "../env";
import { all, bool } from "../lib/db";
import type { HubCtx } from "./context";
import { getAgentRow, getAgentsByHandles } from "./agents";
import { requestAgentWork } from "./jobs";
import { getMessageRow } from "./messages";
import type { AgentRow, ChannelRow, JobRow } from "./rows";

/** Agentes do workspace citados com @handle no texto. */
export async function resolveAgentMentions(db: D1Database, wsId: string, body: string): Promise<AgentRow[]> {
  return getAgentsByHandles(db, wsId, extractMentions(body));
}

export interface RouterCandidate {
  id: string;
  handle: string;
  name: string;
  role: string | null;
  description: string | null;
}

/** Modelo pequeno de texto do Workers AI com suporte a JSON mode (response_format json_schema). */
export const ROUTER_MODEL = "@cf/meta/llama-3-8b-instruct";

/**
 * Regra 3 do roteamento: escolhe no máximo um agente para responder, ou nenhum.
 * Usa o binding `AI` (Workers AI) com saída JSON `{ "agent": "<handle>" | null }`, validada contra os candidatos.
 * Sem o binding (dev/local), ou com qualquer falha (erro, JSON inválido, handle desconhecido), não roteia.
 */
export async function routeWithAI(
  env: Pick<AppEnv, "AI">,
  input: { message: string; channelName: string | null; candidates: RouterCandidate[] },
): Promise<string | null> {
  if (!env.AI || input.candidates.length === 0 || !input.message.trim()) return null;
  const list = input.candidates
    .map((c) => `- ${c.handle}: ${c.name}${c.role ? ` (${c.role})` : ""}${c.description ? ` — ${c.description.slice(0, 200)}` : ""}`)
    .join("\n");
  const system =
    "Você é o roteador de um chat de time. Decida se UM agente deve responder à mensagem, ou nenhum. " +
    "Escolha um agente só se a mensagem for claramente um pedido ou pergunta dentro da função dele. " +
    "Conversa entre pessoas, cumprimentos, avisos e mensagens ambíguas: nenhum. " +
    'Responda apenas com JSON no formato {"agent": "<handle>"} ou {"agent": null}.\n\nAgentes do canal:\n' +
    list;
  const user = `Canal: #${input.channelName ?? "canal"}\nMensagem:\n${input.message.slice(0, 4000)}`;
  try {
    const ai = env.AI as unknown as { run(model: string, inputs: unknown): Promise<unknown> };
    const out = await ai.run(ROUTER_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 40,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: { agent: { type: ["string", "null"] } },
          required: ["agent"],
        },
      },
    });
    const handle = parseRouterOutput(out);
    if (!handle) return null;
    return input.candidates.find((c) => c.handle === handle)?.id ?? null;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "router failed", error: String(err) }));
    return null;
  }
}

/** Extrai o handle da resposta do modelo (objeto já parseado ou texto JSON). Qualquer coisa fora do formato = null. */
export function parseRouterOutput(out: unknown): string | null {
  let payload: unknown = out && typeof out === "object" && "response" in out ? (out as { response: unknown }).response : out;
  if (typeof payload === "string") {
    const match = /\{[\s\S]*\}/.exec(payload);
    if (!match) return null;
    try {
      payload = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const agent = (payload as { agent?: unknown }).agent;
  if (typeof agent !== "string") return null;
  const handle = agent.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle) ? handle : null;
}

/**
 * Roteia uma mensagem de pessoa para agentes (contrato, "Roteamento de mensagens para agentes"):
 * 1. DM com agente; 2. @menções; 3. roteador (sem menção, `routerEnabled`); 4. thread iniciada por agente;
 * 5. canal `humansOnly` nunca cria job.
 */
export async function routeMessage(
  ctx: HubCtx,
  input: { channel: ChannelRow; message: MessageDTO; userId: string; mentionedAgents: AgentRow[]; routerEnabled: boolean },
): Promise<JobRow[]> {
  const { channel, message, userId } = input;
  const db = ctx.env.DB;
  if (bool(channel.humans_only)) return [];
  const targets = new Map<string, AgentRow>();

  if (channel.kind === "dm") {
    const agentMember = await all<{ member_id: string }>(
      db,
      "SELECT member_id FROM channel_members WHERE channel_id = ? AND member_type = 'agent'",
      channel.id,
    );
    for (const m of agentMember) {
      const agent = await getAgentRow(db, ctx.wsId, m.member_id);
      if (agent) targets.set(agent.id, agent);
    }
  } else {
    for (const agent of input.mentionedAgents) targets.set(agent.id, agent);
  }

  // Regra 4: resposta em thread cuja raiz é de um agente vai para esse agente.
  if (message.threadRootId) {
    const root = await getMessageRow(db, ctx.wsId, message.threadRootId);
    if (root?.author_type === "agent" && root.author_id && !targets.has(root.author_id)) {
      const agent = await getAgentRow(db, ctx.wsId, root.author_id);
      if (agent) targets.set(agent.id, agent);
    }
  }

  // Regra 3: sem alvo explícito, canal com agentes membros e roteador ligado.
  if (targets.size === 0 && channel.kind === "channel" && input.routerEnabled) {
    const members = await all<AgentRow>(
      db,
      `SELECT a.* FROM agents a JOIN channel_members cm ON cm.member_type = 'agent' AND cm.member_id = a.id
       WHERE a.workspace_id = ? AND cm.channel_id = ? AND a.status = 'active'`,
      ctx.wsId,
      channel.id,
    );
    if (members.length > 0) {
      const chosen = await routeWithAI(ctx.env, {
        message: message.body,
        channelName: channel.name,
        candidates: members.map((a) => ({ id: a.id, handle: a.handle, name: a.name, role: a.role, description: a.description })),
      });
      const agent = members.find((a) => a.id === chosen);
      if (agent) targets.set(agent.id, agent);
    }
  }

  const jobs: JobRow[] = [];
  for (const agent of targets.values()) {
    // Agente mencionado que não é membro do canal só é acionado se a pessoa puder falar com ele
    // (accessMode) — checado em requestAgentWork junto com pausa e orçamento.
    const job = await requestAgentWork(ctx, {
      agent,
      userId,
      channel,
      prompt: message.body,
      triggerMessageId: message.id,
      threadRootId: message.threadRootId,
    });
    if (job) jobs.push(job);
  }
  return jobs;
}
