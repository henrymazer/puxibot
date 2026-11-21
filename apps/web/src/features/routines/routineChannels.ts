import type { ChannelDTO } from "@puxibot/shared";

/**
 * Canais em que a rotina de um agente pode publicar (mesma regra do hub, `invalid_channel`):
 * nunca só de humanos; canal privado ou DM só se o agente for membro. A lista de entrada já é
 * a dos canais que a pessoa enxerga.
 */
export function routineChannelsFor(channels: ChannelDTO[], agentId: string): ChannelDTO[] {
  return channels.filter((c) => {
    if (c.humansOnly) return false;
    if (c.kind === "channel" && !c.isPrivate) return true;
    return c.members.some((m) => m.type === "agent" && m.id === agentId);
  });
}
