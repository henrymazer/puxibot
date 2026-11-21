import { describe, expect, it } from "vitest";
import type { AgentDTO, MemberDTO } from "@puxibot/shared";
import { canEditAgent, canPauseAgent, HIDDEN_PROMPT_LABEL, isOthersAssistant, jobPromptText } from "./actors";

const me = (userId: string, role: MemberDTO["role"]) => ({ userId, role }) as MemberDTO;
const agent = (over: Partial<AgentDTO>) => ({ ownerUserId: "u-dona", isAssistant: false, ...over }) as AgentDTO;

describe("permissões no perfil do agente", () => {
  it("assistente pessoal de outra pessoa: admin só pausa (e mexe no orçamento), não edita", () => {
    const a = agent({ isAssistant: true });
    expect(isOthersAssistant(a, me("u-admin", "admin"))).toBe(true);
    expect(canEditAgent(a, me("u-admin", "admin"))).toBe(false);
    expect(canPauseAgent(a, me("u-admin", "admin"))).toBe(true);
    expect(canEditAgent(a, me("u-dona", "member"))).toBe(true);
    expect(canPauseAgent(a, me("u-outro", "member"))).toBe(false);
  });
  it("agente comum: responsável ou admin editam", () => {
    const a = agent({});
    expect(canEditAgent(a, me("u-admin", "owner"))).toBe(true);
    expect(canEditAgent(a, me("u-dona", "member"))).toBe(true);
    expect(canEditAgent(a, me("u-outro", "member"))).toBe(false);
  });
});

describe("jobPromptText", () => {
  it("prompt vazio vem de conversa privada", () => {
    expect(jobPromptText({ prompt: "" })).toEqual({ text: HIDDEN_PROMPT_LABEL, hidden: true });
    expect(jobPromptText({ prompt: "  " }).hidden).toBe(true);
    expect(jobPromptText({ prompt: "Resuma o dia" })).toEqual({ text: "Resuma o dia", hidden: false });
  });
});
