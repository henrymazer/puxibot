import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, CircleCheckBig, House, KanbanSquare, Laptop, MessageSquare, PlugZap, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import type { JobDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { isAdmin, jobPromptText } from "../../lib/actors";
import { paths } from "../../lib/paths";
import { formatRelative } from "../../lib/format";
import { STATUS_LABEL } from "../../lib/kanban";
import { AgentAvatar } from "../../components/Avatar";
import { Badge, Button, Card, InlineError } from "../../components/ui";
import { toast } from "../../components/toast";
import { PageHeader } from "../shell/PageHeader";
import { useWsId } from "../shell/hooks";
import { FirstSteps } from "../onboarding/FirstSteps";
import { useOnboardingProgress } from "../onboarding/useOnboarding";
import { mergeJobs, summarizeHome } from "./summary";

export function HomePage() {
  const ws = useWsId();
  const workspace = useWorkspace((s) => s.workspace);
  const me = useWorkspace((s) => s.me);
  const { progress, stored, update } = useOnboardingProgress(ws);
  const [fetched, setFetched] = useState<JobDTO[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const liveJobs = useWorkspace((s) => s.jobs);

  useEffect(() => {
    let alive = true;
    setFetched(null);
    setJobsError(null);
    api
      .listJobs(ws)
      .then((list) => alive && setFetched(list))
      .catch((e) => alive && (setJobsError(errorMessage(e)), setFetched([])));
    if (!useWorkspace.getState().tasksLoaded) {
      useWorkspace
        .getState()
        .loadTasks()
        .catch((e) => alive && setTasksError(errorMessage(e)));
    }
    return () => {
      alive = false;
    };
  }, [ws]);

  const jobs = useMemo(() => (fetched ? mergeJobs(fetched, Object.values(liveJobs)) : null), [fetched, liveJobs]);
  const firstName = me?.name.split(" ")[0];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title="Início"
        icon={<House className="size-5" />}
        subtitle={workspace?.name}
        actions={
          stored && !progress.finished ? (
            <Link
              to={paths.onboarding(ws)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-fg hover:bg-primary-hover max-md:h-10"
            >
              <Sparkles className="size-4" aria-hidden />
              <span className="max-sm:hidden">Continuar configuração</span>
              <span className="sm:hidden">Configurar</span>
            </Link>
          ) : undefined
        }
      />
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-6">
          <h2 className="text-xl font-semibold">{firstName ? `Olá, ${firstName}` : "Olá"}</h2>
          <FirstSteps ws={ws} progress={progress} onChange={update} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
              <NeedsYou jobs={jobs} error={jobsError} />
              <Activity jobs={jobs} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <AssistantCard />
              <MyTasks error={tasksError} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, icon, action, children }: { title: string; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-muted">{icon}</span>
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="space-y-3 p-4" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3">
          <span className="size-7 shrink-0 animate-pulse rounded-md bg-surface-3" />
          <span className="h-3 flex-1 animate-pulse rounded bg-surface-3" style={{ maxWidth: `${80 - i * 12}%` }} />
        </li>
      ))}
    </ul>
  );
}

function NeedsYou({ jobs, error }: { jobs: JobDTO[] | null; error: string | null }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const myUserId = useWorkspace((s) => s.myUserId);
  const approvals = useWorkspace((s) => s.approvals);
  const runners = useWorkspace((s) => s.runners);
  const agents = useWorkspace((s) => s.agents);
  const channels = useWorkspace((s) => s.channels);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const summary = useMemo(
    () =>
      summarizeHome({
        jobs: jobs ?? [],
        approvals: Object.values(approvals),
        runners: Object.values(runners),
        agents: Object.values(agents),
        myUserId,
        admin: isAdmin(me?.role),
        now: Date.now(),
      }),
    [jobs, approvals, runners, agents, myUserId, me?.role],
  );
  const failed = summary.failed.filter((j) => !dismissed.has(j.id));
  const empty = summary.approvals.length === 0 && failed.length === 0 && !summary.runnerWarning;

  const retry = (j: JobDTO) => {
    setRetrying(j.id);
    api
      .retryJob(ws, j.id)
      .then(() => {
        toast.success("Pedido reenviado.");
        setDismissed((d) => new Set(d).add(j.id));
      })
      .catch(toast.error)
      .finally(() => setRetrying(null));
  };

  return (
    <SectionCard title="Precisa de você" icon={<CircleCheckBig className="size-4" />}>
      {error && (
        <div className="p-4 pb-0">
          <InlineError message={error} />
        </div>
      )}
      {jobs === null ? (
        <Skeleton rows={2} />
      ) : empty ? (
        <p className="px-4 py-5 text-sm text-muted">Nada esperando por você agora.</p>
      ) : (
        <ul className="divide-y divide-line">
          {summary.runnerWarning && (
            <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <span className="flex min-w-0 flex-1 items-start gap-2.5">
                <PlugZap className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <span className="min-w-0 text-sm">
                  <span className="block font-medium">
                    {summary.runnerWarning.hasRunner ? "Nenhum computador seu está ligado" : "Você ainda não ligou um computador"}
                  </span>
                  <span className="block text-xs text-muted">
                    {summary.runnerWarning.waiting > 0
                      ? `${summary.runnerWarning.waiting} ${summary.runnerWarning.waiting === 1 ? "pedido espera" : "pedidos esperam"} um computador ligado para começar.`
                      : summary.runnerWarning.ownedAgents > 0
                        ? `Seus ${summary.runnerWarning.ownedAgents} agentes rodam no seu computador quando ninguém mais está com o dele ligado.`
                        : "Os agentes rodam no computador de quem pede, com a assinatura dessa pessoa."}
                  </span>
                </span>
              </span>
              <Link to={paths.settings(ws, "computadores")} className="inline-flex h-8 shrink-0 items-center gap-1 self-start rounded-md border border-line-strong px-3 text-sm hover:bg-surface-2 max-md:h-10 sm:self-auto">
                <Laptop className="size-4" aria-hidden /> Computadores
              </Link>
            </li>
          )}
          {summary.approvals.length > 0 && (
            <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <span className="flex min-w-0 flex-1 items-start gap-2.5">
                <CircleCheckBig className="mt-0.5 size-4 shrink-0 text-agent" aria-hidden />
                <span className="min-w-0 text-sm">
                  <span className="block font-medium">
                    {summary.approvals.length === 1 ? "1 aprovação esperando" : `${summary.approvals.length} aprovações esperando`}
                  </span>
                  <span className="block truncate text-xs text-muted">{summary.approvals.slice(0, 2).map((a) => a.title).join(" · ")}</span>
                </span>
              </span>
              <Link to={paths.approvals(ws)} className="inline-flex h-8 shrink-0 items-center gap-1 self-start rounded-md bg-primary px-3 text-sm font-medium text-primary-fg hover:bg-primary-hover max-md:h-10 sm:self-auto">
                Ver aprovações <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </li>
          )}
          {failed.map((j) => {
            const agent = agents[j.agentId];
            const ch = j.channelId ? channels[j.channelId] : undefined;
            return (
              <li key={j.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                <span className="flex min-w-0 flex-1 items-start gap-2.5">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                  <span className="min-w-0 text-sm">
                    <span className="block font-medium">{agent?.name ?? "Um agente"} parou com um erro</span>
                    <span className="block truncate text-xs text-muted">
                      {j.error ?? "Erro desconhecido."} · {formatRelative(j.finishedAt ?? j.createdAt)}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 gap-2">
                  {ch && (
                    <Link
                      to={j.threadRootId ? paths.thread(ws, ch.id, j.threadRootId) : paths.channel(ws, ch.id)}
                      className="inline-flex h-8 items-center rounded-md px-3 text-sm text-muted hover:bg-surface-2 hover:text-ink max-md:h-10"
                    >
                      Ver conversa
                    </Link>
                  )}
                  <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={retrying === j.id} onClick={() => retry(j)}>
                    Tentar de novo
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function Activity({ jobs }: { jobs: JobDTO[] | null }) {
  const ws = useWsId();
  const agents = useWorkspace((s) => s.agents);
  const channels = useWorkspace((s) => s.channels);
  const members = useWorkspace((s) => s.members);
  const myUserId = useWorkspace((s) => s.myUserId);
  const { profileOpen } = useProfileOpener();
  const recent = useMemo(() => (jobs ? summarizeHome.recentActivity(jobs, 8) : []), [jobs]);

  return (
    <SectionCard title="Atividade recente dos agentes" icon={<Sparkles className="size-4" />}>
      {jobs === null ? (
        <Skeleton />
      ) : recent.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted">Os agentes ainda não trabalharam. Chame um com @ em qualquer canal.</p>
      ) : (
        <ul className="divide-y divide-line">
          {recent.map((j) => {
            const agent = agents[j.agentId];
            const ch = j.channelId ? channels[j.channelId] : undefined;
            const where = ch ? (ch.kind === "dm" ? "numa conversa" : `em #${ch.name}`) : j.origin === "routine" ? "numa rotina" : "";
            const verb = j.status === "running" || j.status === "assigned" ? "está trabalhando" : j.status === "failed" ? "parou com erro" : "respondeu";
            const who = j.requestedByUserId && j.requestedByUserId !== myUserId ? members[j.requestedByUserId]?.name.split(" ")[0] : null;
            const href = ch ? (j.threadRootId ? paths.thread(ws, ch.id, j.threadRootId) : paths.channel(ws, ch.id)) : null;
            const body = (
              <>
                <span className="block text-sm">
                  <span className="font-medium">{agent?.name ?? "Agente removido"}</span> {verb} {where}
                  {who && <span className="text-muted">, em nome de {who}</span>}
                </span>
                <span className="block truncate text-xs text-muted">{jobPromptText(j).text}</span>
              </>
            );
            return (
              <li key={j.id} className="flex items-center gap-3 px-4 py-2.5">
                {agent ? (
                  <button type="button" onClick={() => profileOpen(agent.id)} aria-label={`Perfil de ${agent.name}`} className="rounded-md">
                    <AgentAvatar agent={agent} size="sm" showActivity />
                  </button>
                ) : (
                  <span className="size-7 shrink-0 rounded-md bg-surface-3" aria-hidden />
                )}
                {href ? (
                  <Link to={href} className="min-w-0 flex-1 rounded-sm hover:underline">
                    {body}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1">{body}</span>
                )}
                <time className="shrink-0 text-xs text-subtle" dateTime={new Date(j.finishedAt ?? j.startedAt ?? j.createdAt).toISOString()}>
                  {j.status === "running" ? <Badge tone="agent">agora</Badge> : formatRelative(j.finishedAt ?? j.startedAt ?? j.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function useProfileOpener() {
  const navigate = useNavigate();
  return { profileOpen: (id: string) => navigate({ search: `?agente=${encodeURIComponent(id)}` }) };
}

function AssistantCard() {
  const ws = useWsId();
  const navigate = useNavigate();
  const assistant = useWorkspace((s) => Object.values(s.agents).find((a) => a.isAssistant && a.ownerUserId === s.myUserId));
  const [opening, setOpening] = useState(false);
  if (!assistant) return null;
  const open = () => {
    setOpening(true);
    useWorkspace
      .getState()
      .openDm({ type: "agent", id: assistant.id })
      .then((ch) => navigate(paths.channel(ws, ch.id)))
      .catch(toast.error)
      .finally(() => setOpening(false));
  };
  return (
    <Card>
      <div className="flex items-center gap-3">
        <AgentAvatar agent={assistant} size="lg" showActivity />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{assistant.name}</div>
          <div className="text-xs text-muted">Seu assistente pessoal: lembra prazos, manda recados e faz o resumo do dia.</div>
        </div>
      </div>
      <Button variant="primary" className="mt-3 w-full" icon={<MessageSquare className="size-4" />} loading={opening} onClick={open}>
        Falar com o assistente
      </Button>
    </Card>
  );
}

function MyTasks({ error }: { error: string | null }) {
  const ws = useWsId();
  const tasks = useWorkspace((s) => s.tasks);
  const loaded = useWorkspace((s) => s.tasksLoaded);
  const myUserId = useWorkspace((s) => s.myUserId);
  const mine = useMemo(() => summarizeHome.myTasks(Object.values(tasks), myUserId, 6), [tasks, myUserId]);

  return (
    <SectionCard
      title="Suas tarefas"
      icon={<KanbanSquare className="size-4" />}
      action={
        <Link to={paths.tasks(ws)} className="text-xs font-medium text-primary-text hover:underline">
          Ver quadro
        </Link>
      }
    >
      {error ? (
        <div className="p-4">
          <InlineError message={error} />
        </div>
      ) : !loaded ? (
        <Skeleton rows={3} />
      ) : mine.items.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted">Nenhuma tarefa com você. Bom momento para pedir algo a um agente.</p>
      ) : (
        <ul className="divide-y divide-line">
          {mine.items.map((t) => (
            <li key={t.id}>
              <Link to={paths.tasks(ws, t.id)} className="flex items-start gap-2 px-4 py-2.5 hover:bg-surface-2 max-md:py-3">
                <span className="mt-0.5 shrink-0 text-xs text-subtle tabular-nums">#{t.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{t.title}</span>
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    <Badge tone={t.status === "doing" ? "agent" : t.status === "review" ? "primary" : "neutral"}>{STATUS_LABEL[t.status]}</Badge>
                    {t.priority === "high" && <Badge tone="danger">Alta</Badge>}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {mine.more > 0 && (
            <li className="px-4 py-2 text-xs text-muted">
              e mais {mine.more} no <Link to={paths.tasks(ws)} className="underline">quadro</Link>
            </li>
          )}
        </ul>
      )}
    </SectionCard>
  );
}
