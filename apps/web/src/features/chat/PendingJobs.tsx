import { Link } from "react-router-dom";
import { Clock3, Loader2, PlugZap, RotateCcw, TriangleAlert, X } from "lucide-react";
import type { JobDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { isJobActive, type StreamState } from "../../realtime/reducer";
import { api } from "../../api";
import { toast } from "../../components/toast";
import { AgentAvatar } from "../../components/Avatar";
import { Button } from "../../components/ui";
import { CLI_LABEL } from "../../lib/actors";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { Markdown } from "./Markdown";

interface PendingItem {
  jobId: string;
  agentId: string;
  job?: JobDTO;
  stream?: StreamState;
}

/** Jobs de agente desta conversa que ainda não viraram mensagem final. */
export function usePendingJobs(channelId: string, threadRootId: string | null): PendingItem[] {
  const jobs = useWorkspace((s) => s.jobs);
  const streams = useWorkspace((s) => s.streams);
  const messages = useWorkspace((s) => (threadRootId ? s.threads[threadRootId] : s.messages[channelId]));
  const answered = new Set(messages?.items.map((m) => m.jobId).filter(Boolean));
  const out = new Map<string, PendingItem>();
  for (const j of Object.values(jobs)) {
    if (j.channelId !== channelId || (j.threadRootId ?? null) !== threadRootId) continue;
    if (answered.has(j.id)) continue;
    const show = isJobActive(j) || j.status === "failed" || (j.status === "done" && !!streams[j.id]);
    if (show) out.set(j.id, { jobId: j.id, agentId: j.agentId, job: j, stream: streams[j.id] });
  }
  for (const st of Object.values(streams)) {
    if (st.channelId !== channelId || out.has(st.jobId) || answered.has(st.jobId)) continue;
    const j = jobs[st.jobId];
    if (j && (j.threadRootId ?? null) !== threadRootId) continue;
    if (!j && threadRootId) continue; // sem o job não sabemos a thread: mostra só no canal
    out.set(st.jobId, { jobId: st.jobId, agentId: st.agentId, job: j, stream: st });
  }
  return [...out.values()].sort((a, b) => (a.job?.createdAt ?? a.stream?.updatedAt ?? 0) - (b.job?.createdAt ?? b.stream?.updatedAt ?? 0));
}

/**
 * Texto do pedido que espera um computador. Na DM com agente, só o runner de quem pediu serve (o
 * responsável pelo agente não enxerga a conversa); então, se é o seu pedido e o seu computador está
 * desligado, o aviso diz isso, mesmo que outros computadores do time estejam ligados.
 */
export function waitingForRunnerText(o: { requestedByMe: boolean; myRunnerOnline: boolean; isDm: boolean; agentOwnedByMe: boolean }): string {
  if (o.requestedByMe && !o.myRunnerOnline) {
    if (o.isDm && !o.agentOwnedByMe) {
      return "Esperando o seu computador: esta conversa só roda no seu runner, e ele não está ligado. Ligue o runner (puxibot start) no seu computador e a resposta sai em seguida.";
    }
    return "Esperando um computador: o seu não está ligado e nenhum outro que possa atender este pedido está online. Ligue o runner (puxibot start) no seu computador.";
  }
  return "Nenhum computador que possa atender este pedido está ligado. Responde assim que um ficar online.";
}

export function PendingJobs({ items }: { items: PendingItem[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col">
      {items.map((it) => (
        <PendingJobView key={it.jobId} item={it} />
      ))}
    </div>
  );
}

function PendingJobView({ item }: { item: PendingItem }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const agent = useWorkspace((s) => s.agents[item.agentId]);
  const runnerMember = useWorkspace((s) => (item.job?.runnerUserId ? s.members[item.job.runnerUserId] : undefined));
  const anyRunnerOnline = useWorkspace((s) => Object.values(s.runners).some((r) => r.online));
  const agentHandles = useWorkspace((s) => s.agents);
  const job = item.job;
  const status = job?.status ?? "running";
  const text = item.stream?.text ?? "";
  const name = agent?.name ?? "Agente";
  // O hub informa por job (`waitingForRunner`); hubs antigos não mandam o campo, então cai na estimativa.
  const noRunner =
    status === "queued" &&
    (typeof job?.waitingForRunner === "boolean" ? job.waitingForRunner : agent?.activity === "queued_no_runner" || !anyRunnerOnline);

  const myUserId = useWorkspace((s) => s.myUserId);
  const myRunnerOnline = useWorkspace((s) => Object.values(s.runners).some((r) => r.online && r.userId === s.myUserId));
  const channelKind = useWorkspace((s) => (job?.channelId ? s.channels[job.channelId]?.kind : undefined));
  const waitingText = waitingForRunnerText({
    requestedByMe: !!job?.requestedByUserId && job.requestedByUserId === myUserId,
    myRunnerOnline,
    isDm: channelKind === "dm",
    agentOwnedByMe: agent?.ownerUserId === myUserId,
  });

  const cancel = () => job && api.cancelJob(ws, job.id).catch(toast.error);
  const retry = () => job && api.retryJob(ws, job.id).then(() => toast.success("Pedido reenviado.")).catch(toast.error);

  let statusLine: React.ReactNode = null;
  let tone: "agent" | "danger" | "muted" = "agent";
  if (status === "failed") {
    tone = "danger";
    statusLine = (
      <>
        <TriangleAlert className="size-3.5" aria-hidden />
        <span>{job?.error ? `Parou com um erro: ${job.error}` : "Parou com um erro."}</span>
      </>
    );
  } else if (status === "awaiting_approval") {
    statusLine = (
      <>
        <Clock3 className="size-3.5" aria-hidden />
        <span>
          Esperando aprovação para começar.{" "}
          <Link to={paths.approvals(ws)} className="underline">
            Ver aprovações
          </Link>
        </span>
      </>
    );
  } else if (noRunner) {
    tone = "muted";
    statusLine = (
      <>
        <PlugZap className="size-3.5" aria-hidden />
        <span>
          {waitingText}{" "}
          <Link to={paths.settings(ws, "computadores")} className="underline">
            Computadores
          </Link>
        </span>
      </>
    );
  } else if (status === "queued") {
    statusLine = (
      <>
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span>Na fila…</span>
      </>
    );
  } else if (status === "assigned") {
    statusLine = (
      <>
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span>Começando{runnerMember ? ` no computador de ${runnerMember.name}` : ""}…</span>
      </>
    );
  } else if (!text) {
    statusLine = (
      <>
        <span className="flex gap-0.5" aria-hidden>
          <span className="tb-dot-pulse size-1.5 rounded-full bg-agent" />
          <span className="tb-dot-pulse size-1.5 rounded-full bg-agent [animation-delay:0.2s]" />
          <span className="tb-dot-pulse size-1.5 rounded-full bg-agent [animation-delay:0.4s]" />
        </span>
        <span>Pensando…</span>
      </>
    );
  }

  const handles = new Set(Object.values(agentHandles).map((a) => a.handle));

  return (
    <div className="flex gap-3 px-3 pt-2.5 pb-1 md:px-5" aria-live="polite" aria-busy={status !== "failed"}>
      <div className="w-9 shrink-0">{agent && <AgentAvatar agent={agent} />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{name}</span>
          <span className="rounded-xs bg-agent-soft px-1 text-[10px] font-semibold tracking-wide text-agent uppercase">agente</span>
          {status === "running" && text && <span className="text-xs text-agent">respondendo…</span>}
        </div>
        {text && (
          <div className={cn("text-[15px] leading-relaxed", status === "running" && "tb-caret")}>
            <Markdown text={text} agentHandles={handles} />
          </div>
        )}
        {statusLine && (
          <div
            className={cn(
              "mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs",
              tone === "danger" ? "bg-danger-soft text-danger" : tone === "muted" ? "bg-surface-2 text-muted" : "bg-agent-soft text-agent",
            )}
          >
            {statusLine}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
          {job?.cli && status !== "failed" && (
            <span>
              {[job.model, CLI_LABEL[job.cli]].filter(Boolean).join(" · ")}
              {runnerMember && ` · no computador de ${runnerMember.name}`}
            </span>
          )}
          {job && isJobActive(job) && (
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => void cancel()} className="h-7 px-2 text-xs">
              Cancelar
            </Button>
          )}
          {status === "failed" && job && (
            <>
              <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void retry()}>
                Tentar de novo
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  useWorkspace.setState((s) => {
                    const { [job.id]: _gone, ...jobs } = s.jobs;
                    return { jobs };
                  })
                }
              >
                Dispensar
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
