import { useMemo } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, ChevronRight, Circle, X } from "lucide-react";
import { useWorkspace } from "../../store/workspace";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { IconButton } from "../../components/ui";
import { computeChecklist, pendingCount, type ChecklistId, type OnboardingProgress, type StepId } from "./progress";

/** Dados reais do workspace para a checklist. */
export function useChecklist(progress: OnboardingProgress) {
  const agents = useWorkspace((s) => s.agents);
  const runners = useWorkspace((s) => s.runners);
  const members = useWorkspace((s) => s.members);
  const channels = useWorkspace((s) => s.channels);
  const myUserId = useWorkspace((s) => s.myUserId);
  const tasks = useWorkspace((s) => s.tasks);
  const tasksLoaded = useWorkspace((s) => s.tasksLoaded);
  return useMemo(() => {
    const agentIds = new Set(Object.values(agents).map((a) => a.id));
    const talked = Object.values(channels).some(
      (c) => c.kind === "dm" && c.lastMessageAt !== null && c.members.some((m) => m.type === "agent" && agentIds.has(m.id)),
    );
    return computeChecklist({
      kind: progress.kind,
      agentCount: Object.values(agents).filter((a) => !a.isAssistant).length,
      myRunnerCount: Object.values(runners).filter((r) => r.userId === myUserId).length,
      memberCount: Object.keys(members).length,
      invited: progress.invited,
      talkedToAgent: talked,
      taskCount: tasksLoaded ? Object.keys(tasks).length : null,
    });
  }, [agents, runners, members, channels, myUserId, tasks, tasksLoaded, progress.kind, progress.invited]);
}

const STEP_FOR: Partial<Record<ChecklistId, StepId>> = { agente: "time", computador: "computador", convite: "convite" };

export function FirstSteps({
  ws,
  progress,
  onChange,
}: {
  ws: string;
  progress: OnboardingProgress;
  onChange: (fn: (p: OnboardingProgress) => OnboardingProgress) => void;
}) {
  const items = useChecklist(progress);
  const pending = pendingCount(items);
  const assistant = useWorkspace((s) => Object.values(s.agents).find((a) => a.isAssistant && a.ownerUserId === s.myUserId));
  if (pending === 0 || progress.checklistDismissed) return null;
  const collapsed = progress.checklistCollapsed;
  const doneCount = items.length - pending;

  const linkFor = (id: ChecklistId): string => {
    const step = STEP_FOR[id];
    if (step) return `${paths.onboarding(ws)}?passo=${step}`;
    if (id === "tarefa") return paths.tasks(ws);
    return assistant ? `${paths.team(ws)}?agente=${assistant.id}` : paths.team(ws);
  };

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls="first-steps"
          onClick={() => onChange((p) => ({ ...p, checklistCollapsed: !p.checklistCollapsed }))}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md text-left"
        >
          {collapsed ? <ChevronRight className="size-4 text-muted" aria-hidden /> : <ChevronDown className="size-4 text-muted" aria-hidden />}
          <span className="font-semibold">Primeiros passos</span>
          <span className="text-sm text-muted">
            {doneCount} de {items.length}
          </span>
        </button>
        <div
          className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-surface-3 sm:block"
          role="progressbar"
          aria-label="Primeiros passos feitos"
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-valuenow={doneCount}
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${(doneCount / items.length) * 100}%` }} />
        </div>
        <IconButton label="Esconder primeiros passos" size="sm" onClick={() => onChange((p) => ({ ...p, checklistDismissed: true }))}>
          <X className="size-4" />
        </IconButton>
      </div>
      {!collapsed && (
        <ul id="first-steps" className="divide-y divide-line border-t border-line">
          {items.map((it) => (
            <li key={it.id}>
              <Link
                to={linkFor(it.id)}
                className={cn("flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2 max-md:py-3", it.done && "pointer-events-none")}
                aria-disabled={it.done || undefined}
                tabIndex={it.done ? -1 : undefined}
              >
                {it.done ? (
                  <CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-success" aria-label="Feito" />
                ) : (
                  <Circle className="mt-0.5 size-4.5 shrink-0 text-subtle" aria-label="Pendente" />
                )}
                <span className="min-w-0">
                  <span className={cn("block text-sm font-medium", it.done && "text-muted line-through")}>{it.label}</span>
                  {!it.done && <span className="block text-xs text-muted">{it.hint}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
