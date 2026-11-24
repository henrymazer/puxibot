/** Lógica pura da tela do agente criador: contagens do plano e remoção de itens antes de criar. */
import type { SetupPlan } from "@puxibot/shared";

export type PlanSection = "channels" | "agents" | "skills" | "routines" | "wikiPages" | "memories" | "connectors";

export const SECTION_LABEL: Record<PlanSection, { one: string; many: string }> = {
  agents: { one: "agente", many: "agentes" },
  channels: { one: "canal", many: "canais" },
  routines: { one: "rotina", many: "rotinas" },
  skills: { one: "skill", many: "skills" },
  wikiPages: { one: "página da wiki", many: "páginas da wiki" },
  memories: { one: "memória do time", many: "memórias do time" },
  connectors: { one: "conexão", many: "conexões" },
};

/** "2 agentes, 3 canais e 1 rotina" (só o que existe no plano). */
export function planSummary(plan: SetupPlan): string {
  const order: PlanSection[] = ["agents", "channels", "routines", "skills", "wikiPages", "memories", "connectors"];
  const parts = order
    .map((k) => ({ n: plan[k].length, label: SECTION_LABEL[k] }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.n === 1 ? x.label.one : x.label.many}`);
  if (parts.length <= 1) return parts[0] ?? "nada";
  return `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`;
}

/** Tem algo que o hub consiga criar? (o hub recusa plano só com memórias ou só com conexões) */
export function planHasContent(plan: SetupPlan): boolean {
  return plan.agents.length + plan.channels.length + plan.routines.length + plan.wikiPages.length + plan.skills.length > 0;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Tira um item do plano e tudo que dependia dele, para o plano continuar coerente:
 * sem o agente, saem as rotinas dele; sem a skill ou a conexão, saem as referências nos agentes;
 * sem o canal, ele sai dos agentes e as rotinas deixam de publicar nele.
 */
export function removeFromPlan(plan: SetupPlan, section: PlanSection, index: number): SetupPlan {
  const next: SetupPlan = {
    ...plan,
    channels: [...plan.channels],
    agents: plan.agents.map((a) => ({ ...a })),
    skills: [...plan.skills],
    routines: plan.routines.map((r) => ({ ...r })),
    wikiPages: [...plan.wikiPages],
    memories: [...plan.memories],
    connectors: [...plan.connectors],
  };
  switch (section) {
    case "agents": {
      const [gone] = next.agents.splice(index, 1);
      if (gone) next.routines = next.routines.filter((r) => r.agent !== gone.handle);
      break;
    }
    case "channels": {
      const [gone] = next.channels.splice(index, 1);
      if (gone) {
        for (const a of next.agents) a.channels = a.channels.filter((c) => c !== gone.name);
        next.routines = next.routines.map((r) => (r.channel === gone.name ? { ...r, channel: undefined } : r));
      }
      break;
    }
    case "skills": {
      const [gone] = next.skills.splice(index, 1);
      if (gone) for (const a of next.agents) a.skills = a.skills.filter((s) => !same(s, gone.name));
      break;
    }
    case "connectors": {
      const [gone] = next.connectors.splice(index, 1);
      if (gone) for (const a of next.agents) a.connectors = a.connectors.filter((c) => !same(c, gone.name) && !(gone.catalogId && same(c, gone.catalogId)));
      break;
    }
    case "routines":
      next.routines.splice(index, 1);
      break;
    case "wikiPages":
      next.wikiPages.splice(index, 1);
      break;
    case "memories":
      next.memories.splice(index, 1);
      break;
  }
  return next;
}

/** Troca nome, função ou instruções de um agente do plano (o @ não muda: rotinas apontam para ele). */
export function editPlanAgent(plan: SetupPlan, index: number, patch: { name?: string; role?: string; instructions?: string }): SetupPlan {
  return { ...plan, agents: plan.agents.map((a, i) => (i === index ? { ...a, ...patch } : a)) };
}
