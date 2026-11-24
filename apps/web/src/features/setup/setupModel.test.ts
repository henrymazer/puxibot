import { describe, expect, it } from "vitest";
import { setupPlanSchema, type SetupPlan } from "@puxibot/shared";
import { editPlanAgent, planHasContent, planSummary, removeFromPlan } from "./setupModel";

const plan: SetupPlan = setupPlanSchema.parse({
  summary: "Agência.",
  channels: [{ name: "clientes" }, { name: "midia" }],
  agents: [
    { handle: "midia", name: "Dani", instructions: "Analisa campanhas.", channels: ["clientes", "midia"], connectors: ["meta-ads", "Planilhas"], skills: ["Relatório semanal"] },
    { handle: "atendimento", name: "Bia", instructions: "Atende clientes.", channels: ["clientes"] },
  ],
  skills: [{ name: "Relatório semanal", body: "1. Consulte as campanhas." }],
  routines: [
    { agent: "midia", name: "Relatório de segunda", prompt: "Monte o relatório.", cron: "0 9 * * 1", channel: "midia" },
    { agent: "atendimento", name: "Pendências", prompt: "Liste pendências.", cron: "0 9 * * *", channel: "clientes" },
  ],
  wikiPages: [{ title: "Como atendemos", body: "Em até 4 horas." }],
  memories: ["A Padaria Sol paga no dia 10."],
  connectors: [
    { catalogId: "meta-ads", name: "Meta Ads", reason: "Ler campanhas." },
    { name: "Planilhas", reason: "Guardar relatórios." },
  ],
});

describe("plano do agente criador", () => {
  it("resume só o que existe, com singular e plural", () => {
    expect(planSummary(plan)).toBe("2 agentes, 2 canais, 2 rotinas, 1 skill, 1 página da wiki, 1 memória do time e 2 conexões");
    expect(planSummary({ ...plan, channels: [], routines: [], skills: [], wikiPages: [], memories: [], connectors: [], agents: [plan.agents[0]!] })).toBe("1 agente");
    expect(planHasContent(plan)).toBe(true);
    expect(planHasContent({ ...plan, agents: [], channels: [], routines: [], skills: [], wikiPages: [] })).toBe(false);
  });

  it("tirar um agente tira as rotinas dele e deixa o plano válido", () => {
    const next = removeFromPlan(plan, "agents", 0);
    expect(next.agents.map((a) => a.handle)).toEqual(["atendimento"]);
    expect(next.routines.map((r) => r.name)).toEqual(["Pendências"]);
    expect(() => setupPlanSchema.parse(next)).not.toThrow();
    // O plano original não muda.
    expect(plan.agents).toHaveLength(2);
    expect(plan.routines).toHaveLength(2);
  });

  it("tirar canal, skill ou conexão limpa as referências nos agentes e nas rotinas", () => {
    const noChannel = removeFromPlan(plan, "channels", 1);
    expect(noChannel.agents[0]!.channels).toEqual(["clientes"]);
    expect(noChannel.routines[0]!.channel).toBeUndefined();
    expect(noChannel.routines[1]!.channel).toBe("clientes");
    expect(removeFromPlan(plan, "skills", 0).agents[0]!.skills).toEqual([]);
    // A conexão é referida pelo id do catálogo ou pelo nome.
    expect(removeFromPlan(plan, "connectors", 0).agents[0]!.connectors).toEqual(["Planilhas"]);
    expect(removeFromPlan(plan, "connectors", 1).agents[0]!.connectors).toEqual(["meta-ads"]);
    expect(removeFromPlan(plan, "memories", 0).memories).toEqual([]);
    expect(removeFromPlan(plan, "wikiPages", 0).wikiPages).toEqual([]);
  });

  it("editar um agente troca só os campos pedidos e mantém o @", () => {
    const next = editPlanAgent(plan, 1, { name: "Beatriz", instructions: "Atende com calma." });
    expect(next.agents[1]).toMatchObject({ handle: "atendimento", name: "Beatriz", instructions: "Atende com calma.", channels: ["clientes"] });
    expect(next.agents[0]).toEqual(plan.agents[0]);
  });
});
