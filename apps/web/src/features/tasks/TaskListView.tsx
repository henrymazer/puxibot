import { TASK_STATUSES, type TaskDTO, type TaskStatus } from "@puxibot/shared";
import { Select } from "../../components/ui";
import { column, STATUS_LABEL } from "../../lib/kanban";
import { formatRelative } from "../../lib/format";
import { cn } from "../../lib/cn";
import { ActorAvatar, LabelChip, PriorityIcon, StalledNote, useActorName } from "./TaskBits";
import { moveTask } from "./actions";
import { toast } from "../../components/toast";

/** Visão em lista, agrupada por coluna. */
export function TaskListView({ tasks, onOpen, selectedId }: { tasks: TaskDTO[]; onOpen: (id: string) => void; selectedId: string | null }) {
  const name = useActorName();
  const now = Date.now();
  if (tasks.length === 0) return null;
  return (
    <div className="tb-scroll min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        {TASK_STATUSES.map((s) => {
          const list = column(tasks, s);
          if (list.length === 0) return null;
          return (
            <section key={s} aria-labelledby={`list-${s}`}>
              <h2 id={`list-${s}`} className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-muted">
                {STATUS_LABEL[s]} <span className="font-normal text-subtle">{list.length}</span>
              </h2>
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {list.map((t) => (
                  <li key={t.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 md:flex-nowrap md:px-4", selectedId === t.id && "bg-primary-soft/40")}>
                    <button type="button" onClick={() => onOpen(t.id)} className="flex min-h-9 min-w-0 flex-1 basis-full items-center gap-2 rounded-md text-left md:basis-auto">
                      <span className="w-10 shrink-0 font-mono text-xs text-subtle">#{t.number}</span>
                      <PriorityIcon priority={t.priority} />
                      <span className={cn("min-w-0 truncate text-sm font-medium", t.status === "done" && "text-muted line-through")}>{t.title}</span>
                      <StalledNote task={t} now={now} className="shrink-0 max-sm:hidden" />
                    </button>
                    <span className="flex min-w-0 flex-wrap gap-1 max-md:pl-12 md:w-40 md:justify-end">
                      {t.labels.slice(0, 3).map((l) => (
                        <LabelChip key={l} label={l} />
                      ))}
                    </span>
                    <span className="flex w-40 min-w-0 items-center gap-1.5 text-xs text-muted max-md:pl-12">
                      {t.assignee ? (
                        <>
                          <ActorAvatar actor={t.assignee} />
                          <span className="truncate">{name(t.assignee)}</span>
                        </>
                      ) : (
                        <span className="italic text-subtle">Sem responsável</span>
                      )}
                    </span>
                    <span className="w-20 shrink-0 text-xs text-subtle max-md:hidden">{formatRelative(t.updatedAt)}</span>
                    <Select
                      aria-label={`Coluna da tarefa #${t.number}`}
                      value={t.status}
                      onChange={(e) => moveTask(t.id, e.target.value as TaskStatus, 0).catch(toast.error)}
                      className="h-8 min-h-8 w-36 shrink-0 py-0 text-xs max-md:ml-auto max-md:h-10"
                    >
                      {TASK_STATUSES.map((x) => (
                        <option key={x} value={x}>
                          {STATUS_LABEL[x]}
                        </option>
                      ))}
                    </Select>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
