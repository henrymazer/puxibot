import type { AgentDTO } from "@puxibot/shared";
import type { AgentPatch } from "../../api/client";

/** Só o que mudou vai no PATCH; texto vazio em função e descrição vira `null`. */
export function agentProfilePatch(
  agent: AgentDTO,
  draft: { name: string; handle: string; role: string; description: string; sectorId: string; avatarColor: string; avatarAccessory: string },
): AgentPatch {
  const patch: AgentPatch = {};
  const name = draft.name.trim();
  const role = draft.role.trim() || null;
  const description = draft.description.trim() || null;
  const sectorId = draft.sectorId || null;
  const avatarAccessory = draft.avatarAccessory || null;
  if (name !== agent.name) patch.name = name;
  if (draft.handle !== agent.handle) patch.handle = draft.handle;
  if (role !== (agent.role || null)) patch.role = role;
  if (description !== (agent.description || null)) patch.description = description;
  if (sectorId !== (agent.sectorId || null)) patch.sectorId = sectorId;
  if (draft.avatarColor !== agent.avatarColor) patch.avatarColor = draft.avatarColor;
  if (avatarAccessory !== (agent.avatarAccessory || null)) patch.avatarAccessory = avatarAccessory;
  return patch;
}
