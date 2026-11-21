import type { ActorRef, AgentDTO, ChannelDTO, MemberDTO, Role } from "@puxibot/shared";
import type { DataState } from "../realtime/reducer";

export function isAdmin(role: Role | undefined | null): boolean {
  return role === "owner" || role === "admin";
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Dono", admin: "Admin", member: "Membro" };

export function actorName(s: Pick<DataState, "members" | "agents">, a: { type: string; id: string | null }): string {
  if (a.type === "system") return "Puxibot";
  if (a.type === "agent") return (a.id && s.agents[a.id]?.name) || "Agente removido";
  return (a.id && s.members[a.id]?.name) || "Pessoa removida";
}


/** O outro participante de uma DM (para mostrar nome e avatar). */
export function dmPeer(channel: ChannelDTO, myUserId: string | null): ActorRef | null {
  const others = channel.members.filter((m) => !(m.type === "user" && m.id === myUserId));
  return others[0] ?? channel.members[0] ?? null;
}

export function channelLabel(
  s: Pick<DataState, "members" | "agents" | "myUserId">,
  channel: ChannelDTO,
): string {
  if (channel.kind === "dm") {
    const peer = dmPeer(channel, s.myUserId);
    return peer ? actorName(s, peer) : "Conversa";
  }
  return channel.name ?? "canal";
}

/** Assistente pessoal de outra pessoa: só a dona configura (o hub responde 403 `assistant_owner_only`). */
export function isOthersAssistant(agent: Pick<AgentDTO, "isAssistant" | "ownerUserId">, me: Pick<MemberDTO, "userId"> | null): boolean {
  return agent.isAssistant && agent.ownerUserId !== me?.userId;
}

/** Pode mudar perfil, instruções, acesso, ferramentas e rotinas do agente. */
export function canEditAgent(agent: AgentDTO, me: MemberDTO | null): boolean {
  if (!me) return false;
  if (agent.ownerUserId === me.userId) return true;
  return isAdmin(me.role) && !agent.isAssistant;
}

/** Pode pausar/reativar (no assistente de outra pessoa, admin ainda pode). */
export function canPauseAgent(agent: AgentDTO, me: MemberDTO | null): boolean {
  if (!me) return false;
  return agent.ownerUserId === me.userId || isAdmin(me.role);
}

export const ACTIVITY_LABEL: Record<AgentDTO["activity"], string> = {
  idle: "Disponível",
  working: "Trabalhando",
  waiting_approval: "Esperando aprovação",
  queued_no_runner: "Sem computador ligado",
  error: "Parou com erro",
};

export const CLI_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

/** "Tito, em nome de Renato" quando um agente age por uma pessoa; senão só o nome. */
export function authorshipLabel(
  s: Pick<DataState, "members" | "agents">,
  actor: { type: string; id: string | null },
  onBehalfOfUserId?: string | null,
): string {
  const name = actorName(s, actor);
  if (actor.type !== "agent" || !onBehalfOfUserId) return name;
  const who = s.members[onBehalfOfUserId]?.name?.split(" ")[0] ?? "outra pessoa";
  return `${name}, em nome de ${who}`;
}

/** O hub manda `prompt` vazio quando o pedido veio de uma conversa que quem olha não enxerga. */
export const HIDDEN_PROMPT_LABEL = "Pedido feito em conversa privada";

export function jobPromptText(job: { prompt: string | null | undefined }): { text: string; hidden: boolean } {
  const p = job.prompt?.trim();
  return p ? { text: job.prompt!, hidden: false } : { text: HIDDEN_PROMPT_LABEL, hidden: true };
}
