import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Circle, Wrench, StickyNote } from "lucide-react";
import type { AgentDTO, JobDTO, JobEventDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import type { ActivityItem } from "../../api/client";
import { useWorkspace } from "../../store/workspace";
import { CLI_LABEL, jobPromptText } from "../../lib/actors";
import { formatDateTime, formatNumber, formatTime } from "../../lib/format";
import { paths } from "../../lib/paths";
import { Badge, Button, EmptyState, ErrorState, LoadingState } from "../../components/ui";
import { useWsId } from "../shell/hooks";

const STATUS: Record<JobDTO["status"], { label: string; tone: "neutral" | "agent" | "warning" | "danger" | "success" }> = {
  awaiting_approval: { label: "Aguardando aprovação", tone: "warning" },
  queued: { label: "Na fila", tone: "neutral" },
  assigned: { label: "Entregue a um computador", tone: "agent" },
  running: { label: "Trabalhando", tone: "agent" },
  done: { label: "Concluído", tone: "success" },
  failed: { label: "Erro", tone: "danger" },
  cancelled: { label: "Cancelado", tone: "neutral" },
};

const ORIGIN: Record<JobDTO["origin"], string> = {
  user: "Pedido de pessoa",
  routine: "Rotina",
  agent: "Pedido de outro agente",
  system: "Sistema",
};

const ERROR_LABEL: Record<string, string> = {
  auth: "a CLI recusou o login ou a chave",
  limit: "limite do plano atingido",
  timeout: "demorou demais",
  runner_lost: "o computador desconectou",
  error: "erro",
};

export function ActivityTab({ agent }: { agent: AgentDTO }) {
  const ws = useWsId();
  const members = useWorkspace((s) => s.members);
  const channels = useWorkspace((s) => s.channels);
  const liveJobs = useWorkspace((s) => s.jobs);
  const liveEvents = useWorkspace((s) => s.jobEvents);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .getAgentActivity(ws, agent.id)
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
  }, [ws, agent.id]);
  useEffect(load, [load]);

  // Junta com jobs e eventos que chegaram em tempo real.
  const merged = useMemo(() => {
    if (!items) return null;
    const byId = new Map<string, ActivityItem>();
    for (const it of items) byId.set(it.id, it);
    for (const j of Object.values(liveJobs)) {
      if (j.agentId !== agent.id) continue;
      const prev = byId.get(j.id);
      byId.set(j.id, { ...(prev ?? { events: [] }), ...j });
    }
    return [...byId.values()]
      .map((it) => {
        const extra = liveEvents[it.id] ?? [];
        const seen = new Set(it.events.map((e) => e.id));
        const events: JobEventDTO[] = [...it.events, ...extra.filter((e) => !seen.has(e.id))].sort((a, b) => a.createdAt - b.createdAt);
        return { ...it, events };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [items, liveJobs, liveEvents, agent.id]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!merged) return <LoadingState />;
  if (merged.length === 0)
    return (
      <EmptyState icon={<Activity className="size-5" />} title="Nenhuma atividade ainda">
        Quando alguém chamar {agent.name}, cada trabalho aparece aqui com o que ele fez.
      </EmptyState>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={load}>
          Atualizar
        </Button>
      </div>
      <ul className="flex flex-col gap-3">
        {merged.map((job) => {
          const st = STATUS[job.status];
          const requester = job.requestedByUserId ? members[job.requestedByUserId]?.name : null;
          const runnerOwner = job.runnerUserId ? members[job.runnerUserId]?.name ?? "outra pessoa" : null;
          const channel = job.channelId ? channels[job.channelId] : undefined;
          const crossCost = job.runnerUserId && job.requestedByUserId && job.runnerUserId !== job.requestedByUserId;
          return (
            <li key={job.id} className="rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="text-xs text-muted">{ORIGIN[job.origin]}</span>
                <span className="ml-auto text-xs text-subtle">{formatDateTime(job.createdAt)}</span>
              </div>
              {(() => {
                const p = jobPromptText(job);
                return <p className={p.hidden ? "mt-2 text-sm text-muted italic" : "mt-2 line-clamp-3 text-sm"}>{p.text}</p>;
              })()}
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-2">
                {requester && (
                  <div>
                    <dt className="inline">Pedido por: </dt>
                    <dd className="inline text-ink">{requester}</dd>
                  </div>
                )}
                {runnerOwner && (
                  <div>
                    <dt className="inline">Computador: </dt>
                    <dd className="inline text-ink">
                      de {runnerOwner}
                      {crossCost && <span className="text-warning"> (usa a assinatura dessa pessoa)</span>}
                    </dd>
                  </div>
                )}
                {job.cli && (
                  <div>
                    <dt className="inline">Respondeu com: </dt>
                    <dd className="inline text-ink">
                      {CLI_LABEL[job.cli] ?? job.cli}
                      {job.model ? ` · ${job.model}` : ""}
                    </dd>
                  </div>
                )}
                {(job.inputTokens > 0 || job.outputTokens > 0) && (
                  <div>
                    <dt className="inline">Tokens: </dt>
                    <dd className="inline text-ink">{formatNumber(job.inputTokens + job.outputTokens)}</dd>
                  </div>
                )}
                {channel && (
                  <div>
                    <dt className="inline">Conversa: </dt>
                    <dd className="inline">
                      <Link className="text-primary-text underline" to={paths.channel(ws, channel.id)}>
                        {channel.kind === "dm" ? "mensagem direta" : `#${channel.name}`}
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>
              {job.status === "failed" && (
                <p className="mt-2 rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
                  Parou: {job.error || ERROR_LABEL[job.errorCode ?? "error"]}
                </p>
              )}
              {job.events.length > 0 && (
                <ol className="mt-3 border-l border-line pl-3">
                  {job.events.map((ev) => {
                    const Icon = ev.kind === "tool" ? Wrench : ev.kind === "note" ? StickyNote : Circle;
                    return (
                      <li key={ev.id} className="relative flex gap-2 py-0.5 text-xs">
                        <Icon className="mt-0.5 size-3 shrink-0 text-subtle" aria-hidden />
                        <span className="text-subtle tabular-nums">{formatTime(ev.createdAt)}</span>
                        <span className="min-w-0 text-ink">{ev.summary}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
