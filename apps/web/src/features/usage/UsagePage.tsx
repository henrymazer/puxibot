import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Download, Gauge } from "lucide-react";
import type { AgentActionDTO, UsageEntryDTO, UsageSummaryDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { PageHeader } from "../shell/PageHeader";
import { useWsId } from "../shell/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, InlineError, LoadingState, SectionTitle, Select } from "../../components/ui";
import { actorName, jobPromptText } from "../../lib/actors";
import { formatDayLabel, formatNumber, formatTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import {
  actionCountLabel,
  actionKindLabel,
  actionStatus,
  groupByDay,
  jobStatus,
  lastMonths,
  mergeEntries,
  originLabel,
} from "./usageModel";

const PAGE_SIZE = 50;

export function UsagePage() {
  const ws = useWsId();
  const agents = useWorkspace((s) => s.agents);
  const members = useWorkspace((s) => s.members);
  const months = useMemo(() => lastMonths(), []);
  const [period, setPeriod] = useState(months[0]!.value);
  const [agentId, setAgentId] = useState("");
  const [summary, setSummary] = useState<UsageSummaryDTO | null>(null);
  const [items, setItems] = useState<UsageEntryDTO[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ao trocar mês ou agente, o conteúdo anterior fica na tela (esmaecido) até o novo chegar.
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Descarta respostas de um mês/agente que a pessoa já trocou.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    setMoreError(null);
    setNextBefore(null);
    setLoading(true);
    const q = { period, agentId: agentId || undefined };
    try {
      const [sum, page] = await Promise.all([api.getUsageSummary(ws, q), api.listUsage(ws, { ...q, limit: PAGE_SIZE })]);
      if (mine !== seq.current) return;
      setSummary(sum);
      setItems(page.items);
      setNextBefore(page.nextBefore);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [ws, period, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (nextBefore == null || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.listUsage(ws, { period, agentId: agentId || undefined, before: nextBefore, limit: PAGE_SIZE });
      if (mine !== seq.current) return;
      setItems((prev) => mergeEntries(prev ?? [], page.items));
      setNextBefore(page.nextBefore);
    } catch (e) {
      if (mine === seq.current) setMoreError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const agentOptions = useMemo(() => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")), [agents]);
  const groups = useMemo(() => groupByDay(items ?? []), [items]);
  const agentLabel = (id: string) => actorName({ members, agents }, { type: "agent", id });
  const monthLabel = months.find((m) => m.value === period)?.label ?? period;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title="Uso"
        icon={<Gauge className="size-5" />}
        subtitle="O que os agentes fizeram"
        actions={
          <>
            <label htmlFor="usage-period" className="sr-only">
              Mês
            </label>
            <Select id="usage-period" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-9 w-44 py-1 text-sm max-sm:w-36">
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
            <a
              href={api.usageExportUrl(ws, period)}
              download
              aria-label={`Exportar CSV de ${monthLabel}`}
              title="Exportar CSV"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm font-medium whitespace-nowrap text-ink transition-colors hover:bg-surface-2 max-sm:w-10 max-sm:px-0"
            >
              <Download className="size-4" aria-hidden />
              <span className="max-sm:sr-only">Exportar CSV</span>
            </a>
          </>
        }
      />
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
        <div
          aria-busy={loading}
          className={cn(
            "mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-opacity md:p-6",
            loading && summary && items && "opacity-60",
          )}
        >
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : !summary || !items ? (
            <LoadingState />
          ) : (
            <>
              <SummaryCard summary={summary} monthLabel={monthLabel} />

              {summary.byAgent.length > 0 && (
                <Card>
                  <SectionTitle>Por agente</SectionTitle>
                  <ul className="divide-y divide-line">
                    {summary.byAgent.map((row) => (
                      <li key={row.agentId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm first:pt-0 last:pb-0">
                        <span className="min-w-0 font-medium break-words">{agentLabel(row.agentId)}</span>
                        <span className="text-xs text-muted tabular-nums">
                          {formatNumber(row.runs)} {row.runs === 1 ? "trabalho" : "trabalhos"} · {formatNumber(row.tokens)} tokens
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {summary.routines.length > 0 && <RoutinesProjection routines={summary.routines} agentLabel={agentLabel} />}

              <section aria-labelledby="usage-list-title">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 id="usage-list-title" className="text-base font-semibold">
                    Trabalhos
                  </h2>
                  <div>
                    <label htmlFor="usage-agent" className="sr-only">
                      Filtrar por agente
                    </label>
                    <Select id="usage-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="h-9 w-56 max-w-full py-1 text-sm">
                      <option value="">Todos os agentes</option>
                      {agentOptions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                {items.length === 0 ? (
                  <EmptyState icon={<Gauge className="size-5" />} title="Nenhum trabalho neste mês">
                    {agentId
                      ? `${agentLabel(agentId)} não fez nenhum trabalho em ${monthLabel}.`
                      : `Quando um agente trabalhar em ${monthLabel}, cada trabalho aparece aqui com o que ele fez e por quê.`}
                  </EmptyState>
                ) : (
                  <div className="flex flex-col gap-4">
                    {groups.map((g) => (
                      <div key={g.day}>
                        <h3 className="mb-1.5 px-1 text-xs font-semibold text-muted">{formatDayLabel(g.day)}</h3>
                        <ul className="overflow-hidden rounded-lg border border-line bg-surface">
                          {g.items.map((entry) => (
                            <EntryRow key={entry.jobId} entry={entry} agentName={agentLabel(entry.agentId)} />
                          ))}
                        </ul>
                      </div>
                    ))}
                    <InlineError message={moreError} />
                    {nextBefore != null && !loading && (
                      <div className="flex justify-center">
                        <Button onClick={() => void loadMore()} loading={loadingMore}>
                          Carregar mais
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-2 px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg leading-tight font-semibold break-words tabular-nums">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-subtle">{hint}</dd>}
    </div>
  );
}

function SummaryCard({ summary, monthLabel }: { summary: UsageSummaryDTO; monthLabel: string }) {
  const tokens = summary.inputTokens + summary.outputTokens;
  const a = summary.actions;
  return (
    <Card>
      <SectionTitle>Resumo de {monthLabel}</SectionTitle>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Trabalhos" value={formatNumber(summary.runs)} />
        <Stat label="Tokens" value={formatNumber(tokens)} hint="entrada e saída" />
        <Stat label="Em segundo plano" value={formatNumber(summary.backgroundTokens)} hint="tokens de rotinas e preparação automática" />
        <Stat label="Ações em serviços" value={formatNumber(a.reads + a.writes)} hint={`${formatNumber(a.reads)} leituras · ${formatNumber(a.writes)} ações`} />
      </dl>
      <p className="mt-3 text-sm text-muted">
        <span className="text-ink tabular-nums">{formatNumber(a.asked)}</span> {a.asked === 1 ? "pediu aprovação" : "pediram aprovação"} ·{" "}
        <span className={cn("tabular-nums", a.denied > 0 ? "text-danger" : "text-ink")}>{formatNumber(a.denied)}</span>{" "}
        {a.denied === 1 ? "negada" : "negadas"}
      </p>
      <p className="mt-2 text-xs text-subtle">
        Não há valor em dinheiro aqui: cada agente usa a assinatura de IA da própria pessoa. Tokens medem quanto dessa assinatura foi usado.
      </p>
    </Card>
  );
}

function RoutinesProjection({ routines, agentLabel }: { routines: UsageSummaryDTO["routines"]; agentLabel: (id: string) => string }) {
  return (
    <Card>
      <SectionTitle>Rotinas: projeção para 30 dias</SectionTitle>
      <div className="tb-scroll -mx-1 overflow-x-auto px-1">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th scope="col" className="py-1.5 pr-2 font-medium">
                Rotina
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Execuções/mês
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Média de tokens
              </th>
              <th scope="col" className="py-1.5 pl-2 text-right font-medium">
                Projeção
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {routines.map((r) => (
              <tr key={r.routineId} className="align-top">
                <th scope="row" className="py-2 pr-2 text-left font-normal">
                  <span className="block font-medium break-words">{r.name}</span>
                  <span className="block text-xs text-muted break-words">{agentLabel(r.agentId)}</span>
                </th>
                <td className="px-2 py-2 text-right tabular-nums">{formatNumber(r.runsPerMonth)}</td>
                {r.runs === 0 ? (
                  <td colSpan={2} className="py-2 pl-2 text-right text-xs text-subtle">
                    sem execuções ainda
                  </td>
                ) : (
                  <>
                    <td className="px-2 py-2 text-right tabular-nums">{formatNumber(Math.round(r.avgTokens))}</td>
                    <td className="py-2 pl-2 text-right font-medium tabular-nums">
                      {formatNumber(Math.round(r.projectedTokensMonth))} <span className="text-xs font-normal text-muted">tokens</span>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-subtle">Média das últimas execuções de cada rotina, multiplicada pelas execuções previstas em 30 dias.</p>
    </Card>
  );
}

function EntryRow({ entry, agentName }: { entry: UsageEntryDTO; agentName: string }) {
  const members = useWorkspace((s) => s.members);
  const me = useWorkspace((s) => s.me);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const count = entry.actions.length;
  const st = jobStatus(entry.status);
  const prompt = jobPromptText(entry);
  const tokens = entry.inputTokens + entry.outputTokens;
  const origin = originLabel(entry, {
    name: entry.requestedByUserId ? members[entry.requestedByUserId]?.name ?? "pessoa removida" : null,
    isMe: !!me && entry.requestedByUserId === me.userId,
  });

  // Só `span`: este bloco vai dentro de um <button> quando a linha abre.
  const body = (
    <span className="block min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="text-subtle tabular-nums">{formatTime(entry.createdAt)}</span>
        <span className="text-sm font-medium break-words text-ink">{agentName}</span>
        <span className="break-words">{origin}</span>
        <Badge tone={st.tone} className="ml-auto">
          {st.label}
        </Badge>
      </span>
      <span className={cn("mt-1 block text-sm break-words", open ? "whitespace-pre-wrap" : "line-clamp-2", prompt.hidden && "text-muted italic")}>
        {prompt.text}
      </span>
      <span className="mt-1 block text-xs text-muted">
        {tokens > 0 && <>{formatNumber(tokens)} tokens · </>}
        {actionCountLabel(count)}
      </span>
    </span>
  );

  return (
    <li className="border-b border-line last:border-b-0">
      {count > 0 ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
        >
          <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-subtle transition-transform", open && "rotate-90")} aria-hidden />
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-3 py-2.5">
          <span className="size-4 shrink-0" aria-hidden />
          {body}
        </div>
      )}
      {open && count > 0 && (
        <ul id={panelId} aria-label="Ações deste trabalho" className="divide-y divide-line border-t border-line bg-surface-2 pr-3 pl-9">
          {entry.actions.map((a) => (
            <ActionItem key={a.id} action={a} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ActionItem({ action: a }: { action: AgentActionDTO }) {
  const st = actionStatus(a);
  return (
    <li className="min-w-0 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium break-words">{a.connectorName}</span>
        <span className="font-mono text-xs break-all text-muted">{a.tool}</span>
        <Badge>{actionKindLabel(a.kind)}</Badge>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-subtle tabular-nums">{formatTime(a.createdAt)}</span>
          <Badge tone={st.tone}>{st.label}</Badge>
        </span>
      </div>
      {a.reason && <p className="mt-1 text-sm break-words">{a.reason}</p>}
      {a.summary && <p className="mt-1 font-mono text-xs break-all whitespace-pre-wrap text-subtle">{a.summary}</p>}
      {a.error && <p className="mt-1 text-xs break-words text-danger">{a.error}</p>}
    </li>
  );
}
