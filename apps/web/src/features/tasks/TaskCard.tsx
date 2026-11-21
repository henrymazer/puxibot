import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CheckSquare, GitPullRequest, GripVertical, MessageSquare, MoreHorizontal } from "lucide-react";
import { TASK_STATUSES, type TaskDTO, type TaskStatus } from "@puxibot/shared";
import { Popover, MenuItem } from "../../components/Popover";
import { IconButton } from "../../components/ui";
import { STATUS_LABEL } from "../../lib/kanban";
import { cn } from "../../lib/cn";
import { ActorAvatar, LabelChip, PriorityIcon, StalledNote, useActorName } from "./TaskBits";

export interface CardProps {
  task: TaskDTO;
  onOpen: (id: string) => void;
  /** Mover para coluna/posição pelo menu ou pelo teclado. */
  onMove: (id: string, status: TaskStatus, index: number | "top" | "bottom") => void;
  onKeyMove?: (id: string, dir: "up" | "down" | "left" | "right") => void;
  onPointerDownCard?: (e: ReactPointerEvent<HTMLElement>, task: TaskDTO, fromHandle: boolean) => void;
  dragging?: boolean;
  now: number;
}

export const TaskCard = memo(function TaskCard({ task: t, onOpen, onMove, onKeyMove, onPointerDownCard, dragging, now }: CardProps) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const name = useActorName();
  const done = t.subtasks.filter((s) => s.done).length;
  const pr = t.links.find((l) => l.kind === "pr") ?? t.links.find((l) => l.kind === "issue");

  return (
    <article
      data-task-id={t.id}
      onPointerDown={(e) => onPointerDownCard?.(e, t, false)}
      className={cn(
        "group relative rounded-lg border border-line bg-surface shadow-[0_1px_0_rgb(0_0_0/0.03)] transition-[opacity,box-shadow] select-none hover:border-line-strong",
        dragging && "opacity-35",
        t.status === "done" && "bg-surface/70",
      )}
    >
      <button
        type="button"
        data-task-open={t.id}
        onClick={() => onOpen(t.id)}
        onKeyDown={(e) => {
          if (!e.altKey || !onKeyMove) return;
          const dir = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[e.key as "ArrowUp"];
          if (dir) {
            e.preventDefault();
            onKeyMove(t.id, dir);
          }
        }}
        aria-describedby={`task-meta-${t.id}`}
        className="block w-full rounded-lg px-3 pt-2.5 pb-2 text-left focus-visible:outline-offset-0 max-md:pr-10"
      >
        <span className="flex items-center gap-1.5 text-[11px] text-subtle">
          <span className="font-mono">#{t.number}</span>
          {t.project && <span className="truncate">· {t.project}</span>}
          <span className="flex-1" />
          <PriorityIcon priority={t.priority} />
        </span>
        <span className={cn("mt-0.5 block text-sm leading-snug font-medium break-words", t.status === "done" && "text-muted line-through decoration-line-strong")}>{t.title}</span>
        {t.labels.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {t.labels.slice(0, 4).map((l) => (
              <LabelChip key={l} label={l} />
            ))}
            {t.labels.length > 4 && <span className="text-[11px] text-subtle">+{t.labels.length - 4}</span>}
          </span>
        )}
        <span id={`task-meta-${t.id}`} className="mt-2 flex items-center gap-2.5 text-xs text-subtle">
          {t.assignee ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <ActorAvatar actor={t.assignee} />
              <span className="truncate">{name(t.assignee)}</span>
            </span>
          ) : (
            <span className="italic">Sem responsável</span>
          )}
          <span className="flex-1" />
          {t.subtasks.length > 0 && (
            <span className="inline-flex items-center gap-0.5" title="Subtarefas feitas">
              <CheckSquare className="size-3.5" aria-hidden />
              {done}/{t.subtasks.length}
            </span>
          )}
          {t.commentCount > 0 && (
            <span className="inline-flex items-center gap-0.5" title="Comentários">
              <MessageSquare className="size-3.5" aria-hidden />
              {t.commentCount}
            </span>
          )}
          {pr && (
            <span className="inline-flex items-center gap-0.5" title={pr.kind === "pr" ? "Pull request" : "Issue"}>
              <GitPullRequest className="size-3.5" aria-hidden />
              {pr.label}
            </span>
          )}
        </span>
        <StalledNote task={t} now={now} className="mt-2" />
      </button>

      {/* Alça de arrastar no toque (no mouse, a carta inteira arrasta). */}
      <span
        data-drag-handle
        aria-hidden
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDownCard?.(e, t, true);
        }}
        className="absolute top-1 right-1 hidden size-10 touch-none items-center justify-center rounded-md text-subtle [@media(pointer:coarse)]:flex"
      >
        <GripVertical className="size-4" />
      </span>

      <IconButton
        ref={anchor}
        size="sm"
        label={`Mover #${t.number}`}
        onClick={() => setMenu((v) => !v)}
        className="absolute right-1 bottom-1 size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:size-10 [@media(pointer:coarse)]:opacity-100"
      >
        <MoreHorizontal className="size-4" />
      </IconButton>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} align="end" label={`Mover a tarefa #${t.number}`} className="w-60 py-1">
        <div role="menu">
          <p className="px-3 pt-1 pb-1.5 text-xs font-semibold text-subtle">Mover para</p>
          {TASK_STATUSES.filter((s) => s !== t.status).map((s) => (
            <MenuItem
              key={s}
              onClick={() => {
                setMenu(false);
                onMove(t.id, s, "top");
              }}
            >
              {STATUS_LABEL[s]}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-line" />
          <MenuItem
            onClick={() => {
              setMenu(false);
              onMove(t.id, t.status, "top");
            }}
          >
            Topo de “{STATUS_LABEL[t.status]}”
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(false);
              onMove(t.id, t.status, "bottom");
            }}
          >
            Fim de “{STATUS_LABEL[t.status]}”
          </MenuItem>
          <p className="px-3 pt-1.5 pb-1 text-[11px] text-subtle max-md:hidden">Dica: com a tarefa em foco, Alt + setas também move.</p>
        </div>
      </Popover>
    </article>
  );
});
