import { describe, expect, it } from "vitest";
import type { AgentDTO } from "@puxibot/shared";
import { agentProfilePatch } from "./profilePatch";

const agent = {
  id: "a1",
  name: "Tito",
  handle: "tito",
  role: "Engenharia",
  description: "Cuida do código.",
  sectorId: null,
  avatarColor: "#111111",
  avatarAccessory: null,
} as AgentDTO;

const same = { name: "Tito", handle: "tito", role: "Engenharia", description: "Cuida do código.", sectorId: "", avatarColor: "#111111", avatarAccessory: "" };

describe("agentProfilePatch", () => {
  it("não manda nada quando nada mudou", () => {
    expect(agentProfilePatch(agent, same)).toEqual({});
    expect(agentProfilePatch(agent, { ...same, name: "  Tito ", description: "Cuida do código.  " })).toEqual({});
  });

  it("manda só os campos alterados", () => {
    expect(agentProfilePatch(agent, { ...same, description: "Revisa PRs." })).toEqual({ description: "Revisa PRs." });
    expect(agentProfilePatch(agent, { ...same, name: "Tita", handle: "tita", sectorId: "s1" })).toEqual({ name: "Tita", handle: "tita", sectorId: "s1" });
  });

  it("texto apagado vira null", () => {
    expect(agentProfilePatch(agent, { ...same, role: " ", description: "" })).toEqual({ role: null, description: null });
  });
});
