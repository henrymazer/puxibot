import { describe, expect, it } from "vitest";
import type { AgentDTO, AgentUsageDTO, MemberDTO } from "@puxibot/shared";
import { budgetPercent } from "../agents/shared";
import { accessLabel, mapLimit, usageByPerson, usageTotals } from "./governance";

const usage = (runs: number, tokens: number, by: [string, number, number][] = []): AgentUsageDTO => ({
  period: "2026-11",
  runs,
  inputTokens: tokens,
  outputTokens: 0,
  byRunnerUser: by.map(([userId, r, t]) => ({ userId, runs: r, tokens: t })),
});
const agent = (p: Partial<AgentDTO>) => ({ id: "a", accessMode: "workspace", allowedUserIds: [], budgetRunsMonth: null, budgetTokensMonth: null, ...p }) as AgentDTO;

describe("governança e uso", () => {
  it("mapLimit respeita o limite e mantém a ordem, inclusive com erros", async () => {
    let running = 0;
    let peak = 0;
    const res = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5 * (6 - n)));
      running--;
      if (n === 3) throw new Error("x");
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(res.map((r) => (r.status === "fulfilled" ? r.value : "erro"))).toEqual([10, 20, "erro", 40, 50]);
  });

  it("descreve quem pode falar", () => {
    expect(accessLabel(agent({}))).toBe("Todo o workspace");
    expect(accessLabel(agent({ accessMode: "owner" }))).toBe("Só o responsável");
    expect(accessLabel(agent({ accessMode: "restricted", allowedUserIds: ["x", "y"] }))).toBe("2 pessoas escolhidas");
  });

  it("uso por pessoa ordenado e com fração", () => {
    const members = { u1: { name: "Ana" }, u2: { name: "Bruno" } } as unknown as Record<string, MemberDTO>;
    const rows = usageByPerson(usage(4, 100, [["u1", 1, 10], ["u2", 3, 90], ["u9", 0, 0]]), members);
    expect(rows.map((r) => [r.name, r.share])).toEqual([["Bruno", 0.75], ["Ana", 0.25], ["Pessoa removida", 0]]);
  });

  it("totais e agentes perto ou acima do orçamento", () => {
    const agents = [agent({ id: "a", budgetRunsMonth: 10 }), agent({ id: "b", budgetRunsMonth: 10 }), agent({ id: "c" }), agent({ id: "d" })];
    const t = usageTotals(agents, { a: usage(8, 100), b: usage(12, 50), c: usage(1, 5) }, budgetPercent);
    expect(t).toEqual({ runs: 21, tokens: 155, nearBudget: 1, overBudget: 1 });
  });
});
