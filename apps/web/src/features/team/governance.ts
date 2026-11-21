/** Agregação da aba "Governança e uso". Testado em governance.test.ts. */
import type { AgentDTO, AgentUsageDTO, MemberDTO } from "@puxibot/shared";

/** Roda `fn` em todos os itens com no máximo `limit` ao mesmo tempo, mantendo a ordem dos resultados. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function accessLabel(a: AgentDTO): string {
  if (a.accessMode === "workspace") return "Todo o workspace";
  if (a.accessMode === "owner") return "Só o responsável";
  const n = a.allowedUserIds.length;
  return n === 1 ? "1 pessoa escolhida" : `${n} pessoas escolhidas`;
}

export interface UsageByPerson {
  userId: string;
  name: string;
  runs: number;
  tokens: number;
  /** Fração das execuções do agente. */
  share: number;
}

/** Uso por pessoa cuja assinatura executou, maior primeiro. */
export function usageByPerson(usage: AgentUsageDTO, members: Record<string, MemberDTO>): UsageByPerson[] {
  const total = usage.byRunnerUser.reduce((n, r) => n + r.runs, 0) || 1;
  return usage.byRunnerUser
    .map((r) => ({ userId: r.userId, name: members[r.userId]?.name ?? "Pessoa removida", runs: r.runs, tokens: r.tokens, share: r.runs / total }))
    .sort((a, b) => b.runs - a.runs || b.tokens - a.tokens);
}

export interface UsageTotals {
  runs: number;
  tokens: number;
  /** Agentes com orçamento a 80% ou mais. */
  nearBudget: number;
  overBudget: number;
}

export function usageTotals(agents: AgentDTO[], usage: Record<string, AgentUsageDTO | undefined>, percent: (a: AgentDTO, u: AgentUsageDTO | null) => number | null): UsageTotals {
  let runs = 0;
  let tokens = 0;
  let nearBudget = 0;
  let overBudget = 0;
  for (const a of agents) {
    const u = usage[a.id];
    if (!u) continue;
    runs += u.runs;
    tokens += u.inputTokens + u.outputTokens;
    const p = percent(a, u);
    if (p !== null && p >= 100) overBudget++;
    else if (p !== null && p >= 80) nearBudget++;
  }
  return { runs, tokens, nearBudget, overBudget };
}
