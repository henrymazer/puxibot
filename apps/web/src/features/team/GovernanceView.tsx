import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { AgentDTO, AgentUsageDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { formatNumber } from "../../lib/format";
import { cn } from "../../lib/cn";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Badge, Button, Card, InlineError } from "../../components/ui";
import { budgetPercent, UsageBar } from "../agents/shared";
import { useAgentProfile, useWsId } from "../shell/hooks";
import { accessLabel, mapLimit, usageByPerson, usageTotals } from "./governance";

type UsageState = Record<string, { usage?: AgentUsageDTO; error?: string }>;

/** Aba "Governança e uso": só admins. Uso do mês de cada agente, carregado com até 4 pedidos ao mesmo tempo. */
export function GovernanceView({ agents }: { agents: AgentDTO[] }) {
  const ws = useWsId();
  const members = useWorkspace((s) => s.members);
  const profile = useAgentProfile();
  const [state, setState] = useState<UsageState | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const period = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date());
  const ids = agents.map((a) => a.id).join(",");

  const load = useCallback(() => {
    setState(null);
    let alive = true;
    const list = ids ? ids.split(",") : [];
    void mapLimit(list, 4, (id) => api.getAgentUsage(ws, id)).then((res) => {
      if (!alive) return;
      const next: UsageState = {};
      res.forEach((r, i) => {
        next[list[i]!] = r.status === "fulfilled" ? { usage: r.value } : { error: errorMessage(r.reason) };
      });
      setState(next);
    });
    return () => {
      alive = false;
    };
  }, [ws, ids]);
  useEffect(load, [load]);

  const totals = useMemo(
    () => usageTotals(agents, Object.fromEntries(Object.entries(state ?? {}).map(([k, v]) => [k, v.usage])), budgetPercent),
    [agents, state],
  );

  const toggle = (id: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">
            Uso de <span className="font-medium text-ink">{period}</span>. Cada execução usa a assinatura de quem tinha o computador ligado. Só admins
            veem esta aba.
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={load} loading={state === null}>
          Atualizar
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Agentes" value={formatNumber(agents.length)} />
        <Stat label="Execuções no mês" value={state ? formatNumber(totals.runs) : "…"} />
        <Stat label="Tokens no mês" value={state ? formatNumber(totals.tokens) : "…"} />
        <Stat
          label="Orçamento"
          value={state ? (totals.overBudget ? `${totals.overBudget} no limite` : totals.nearBudget ? `${totals.nearBudget} perto do limite` : "Tudo ok") : "…"}
          tone={totals.overBudget ? "danger" : totals.nearBudget ? "warning" : undefined}
        />
      </dl>

      {/* Desktop: tabela. Celular: cartões (sem rolagem lateral). */}
      <div className="hidden overflow-hidden rounded-lg border border-line bg-surface md:block">
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">Agentes, responsáveis, acesso, uso e orçamento do mês</caption>
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th scope="col" className="w-[26%] px-4 py-2 font-medium">Agente</th>
              <th scope="col" className="w-[17%] px-3 py-2 font-medium">Responsável</th>
              <th scope="col" className="w-[17%] px-3 py-2 font-medium">Quem pode falar</th>
              <th scope="col" className="w-[18%] px-3 py-2 font-medium">Uso do mês</th>
              <th scope="col" className="w-[22%] px-4 py-2 font-medium">Orçamento</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {agents.map((a) => {
              const st = state?.[a.id];
              const owner = members[a.ownerUserId];
              const expanded = open.has(a.id);
              const people = st?.usage ? usageByPerson(st.usage, members) : [];
              return (
                <Fragment key={a.id}>
                  <tr className="align-middle">
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => profile.open(a.id, "configuracoes")} className="flex min-w-0 items-center gap-2.5 rounded-md text-left">
                        <AgentAvatar agent={a} size="sm" showActivity />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{a.name}</span>
                          <span className="block truncate text-xs text-subtle">@{a.handle}{a.status === "paused" ? " · pausado" : ""}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <PersonAvatar member={owner} name="?" size="xs" />
                        <span className="truncate">{owner?.name ?? "Pessoa removida"}</span>
                      </span>
                    </td>
                    <td className="truncate px-3 py-2.5 text-muted">{accessLabel(a)}</td>
                    <td className="px-3 py-2.5">
                      <UsageCell st={st} loading={state === null} expanded={expanded} onToggle={people.length ? () => toggle(a.id) : undefined} name={a.name} />
                    </td>
                    <td className="px-4 py-2.5">
                      <BudgetCell agent={a} usage={st?.usage ?? null} />
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="bg-surface-2/50">
                      <td colSpan={5} className="px-4 py-2">
                        <PeopleUsage people={people} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {agents.map((a) => {
          const st = state?.[a.id];
          const owner = members[a.ownerUserId];
          const expanded = open.has(a.id);
          const people = st?.usage ? usageByPerson(st.usage, members) : [];
          return (
            <li key={a.id}>
              <Card className="p-3">
                <button type="button" onClick={() => profile.open(a.id, "configuracoes")} className="flex w-full min-w-0 items-center gap-2.5 text-left">
                  <AgentAvatar agent={a} size="md" showActivity />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{a.name}</span>
                    <span className="block truncate text-xs text-muted">Responsável: {owner?.name ?? "Pessoa removida"}</span>
                  </span>
                </button>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted">Quem pode falar</dt>
                    <dd>{accessLabel(a)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Uso do mês</dt>
                    <dd>
                      <UsageCell st={st} loading={state === null} expanded={expanded} onToggle={people.length ? () => toggle(a.id) : undefined} name={a.name} />
                    </dd>
                  </div>
                </dl>
                <div className="mt-3">
                  <BudgetCell agent={a} usage={st?.usage ?? null} />
                </div>
                {expanded && (
                  <div className="mt-3 border-t border-line pt-2">
                    <PeopleUsage people={people} />
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warning" }) {
  return (
    <Card className="p-3 md:p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-base font-semibold", tone === "danger" && "text-danger", tone === "warning" && "text-warning")}>{value}</dd>
    </Card>
  );
}

function UsageCell({
  st,
  loading,
  expanded,
  onToggle,
  name,
}: {
  st: { usage?: AgentUsageDTO; error?: string } | undefined;
  loading: boolean;
  expanded: boolean;
  onToggle?: () => void;
  name: string;
}) {
  if (loading) return <span className="inline-block h-3 w-20 animate-pulse rounded bg-surface-3" aria-label="Carregando uso" />;
  if (!st?.usage) return <InlineError message={st?.error ?? "Sem dados"} />;
  const u = st.usage;
  const text = (
    <span className="min-w-0">
      <span className="block">{formatNumber(u.runs)} {u.runs === 1 ? "execução" : "execuções"}</span>
      <span className="block text-xs text-muted">{formatNumber(u.inputTokens + u.outputTokens)} tokens</span>
    </span>
  );
  if (!onToggle) return text;
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={`Uso de ${name} por pessoa`} className="flex items-start gap-1 rounded-md text-left hover:text-primary-text max-md:min-h-10">
      {expanded ? <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />}
      {text}
    </button>
  );
}

function BudgetCell({ agent, usage }: { agent: AgentDTO; usage: AgentUsageDTO | null }) {
  const pct = budgetPercent(agent, usage);
  const limits = [
    agent.budgetRunsMonth ? `${formatNumber(agent.budgetRunsMonth)} execuções` : null,
    agent.budgetTokensMonth ? `${formatNumber(agent.budgetTokensMonth)} tokens` : null,
  ].filter(Boolean);
  if (limits.length === 0) return <Badge>Sem orçamento</Badge>;
  return (
    <div className="min-w-0">
      {pct !== null ? <UsageBar percent={pct} label={`Limite: ${limits.join(" ou ")}`} /> : <span className="text-xs text-muted">Limite: {limits.join(" ou ")}</span>}
    </div>
  );
}

function PeopleUsage({ people }: { people: ReturnType<typeof usageByPerson> }) {
  const members = useWorkspace((s) => s.members);
  return (
    <ul className="flex max-w-xl flex-col gap-1.5" aria-label="Uso por pessoa cuja assinatura executou">
      {people.map((p) => (
        <li key={p.userId} className="flex items-center gap-2 text-sm">
          <PersonAvatar member={members[p.userId]} name={p.name} size="xs" />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <span className="shrink-0 text-xs text-muted tabular-nums">
            {formatNumber(p.runs)} exec. · {formatNumber(p.tokens)} tokens · {Math.round(p.share * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}
