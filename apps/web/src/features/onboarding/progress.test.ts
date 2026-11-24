import { describe, expect, it } from "vitest";
import {
  applicableSteps,
  completeStep,
  computeChecklist,
  goTo,
  initialProgress,
  pendingCount,
  skipAll,
  skipStep,
  stepNumber,
  type ChecklistInput,
} from "./progress";

describe("progresso do onboarding", () => {
  it("começa no segundo passo (o primeiro é respondido ao criar o workspace)", () => {
    const p = initialProgress("team");
    expect(p.current).toBe("voce");
    expect(p.done).toEqual(["uso"]);
    expect(stepNumber(p, "voce")).toEqual({ n: 2, total: 5 });
  });

  it("workspace pessoal não tem o passo de convite", () => {
    expect(applicableSteps("personal")).not.toContain("convite");
    expect(stepNumber(initialProgress("personal"), "montar")).toEqual({ n: 4, total: 4 });
    // O computador vem antes de montar o time: o agente criador precisa dele.
    expect(applicableSteps("team").indexOf("computador")).toBeLessThan(applicableSteps("team").indexOf("montar"));
  });

  it("avança concluindo ou pulando e termina no último", () => {
    let p = initialProgress("team");
    p = completeStep(p, "voce");
    expect(p.current).toBe("computador");
    p = skipStep(p, "computador");
    p = skipStep(p, "montar");
    expect(p.current).toBe("convite");
    expect(p.finished).toBe(false);
    p = completeStep(p, "convite");
    expect(p.finished).toBe(true);
    expect(p.skipped).toEqual(["computador", "montar"]);
  });

  it("retomar um passo pulado e concluí-lo tira da lista de pulados", () => {
    let p = skipAll(initialProgress("team"));
    expect(p.finished).toBe(true);
    expect(p.skipped).toEqual(["voce", "computador", "montar", "convite"]);
    p = goTo(p, "computador");
    expect(p).toMatchObject({ current: "computador", finished: false });
    p = completeStep(p, "computador");
    expect(p.skipped).not.toContain("computador");
    expect(p.done).toContain("computador");
    // os outros continuam pulados: nada pendente, então termina
    expect(p.finished).toBe(true);
  });

  it("depois do último passo volta para algum pendente anterior", () => {
    let p = initialProgress("personal");
    p = goTo(p, "montar");
    p = completeStep(p, "montar");
    expect(p.current).toBe("voce");
    expect(p.finished).toBe(false);
  });
});

describe("checklist primeiros passos", () => {
  const base: ChecklistInput = { kind: "team", agentCount: 0, myRunnerCount: 0, memberCount: 1, invited: false, talkedToAgent: false, taskCount: null };

  it("lista tudo pendente num workspace novo", () => {
    const items = computeChecklist(base);
    expect(items.map((i) => i.id)).toEqual(["agente", "computador", "convite", "conversa", "tarefa"]);
    expect(pendingCount(items)).toBe(5);
  });

  it("marca o que já existe de verdade", () => {
    const items = computeChecklist({ ...base, agentCount: 3, myRunnerCount: 1, memberCount: 2, talkedToAgent: true, taskCount: 4 });
    expect(pendingCount(items)).toBe(0);
  });

  it("convite gerado conta como feito; pessoal não tem convite", () => {
    expect(computeChecklist({ ...base, invited: true }).find((i) => i.id === "convite")!.done).toBe(true);
    expect(computeChecklist({ ...base, kind: "personal" }).some((i) => i.id === "convite")).toBe(false);
  });
});
