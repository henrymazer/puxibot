/**
 * Quadro kanban com arrastar e soltar por Pointer Events (mouse, toque e caneta).
 * Mouse: arrasta a carta inteira depois de 5 px. Toque: pela alça (o resto da carta rola a coluna).
 * Alternativas sem arrastar: menu "Mover para" em cada carta e Alt + setas com a carta em foco.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Plus } from "lucide-react";
import { TASK_STATUSES, type TaskDTO, type TaskStatus } from "@puxibot/shared";
import { column, keyboardTarget, STATUS_LABEL } from "../../lib/kanban";
import { cn } from "../../lib/cn";
import { IconButton } from "../../components/ui";
import { toast } from "../../components/toast";
import { TaskCard } from "./TaskCard";
import { moveTask } from "./actions";

interface DragState {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  /** Ponto onde a carta foi pega, relativo a ela. */
  dx: number;
  dy: number;
  width: number;
  height: number;
  over: { status: TaskStatus; index: number } | null;
}

const STATUS_DOT: Record<TaskStatus, string> = {
  todo: "bg-subtle",
  doing: "bg-agent",
  review: "bg-primary",
  done: "bg-success",
};

export function TaskBoard({
  tasks,
  allTasks,
  onOpen,
  onCreate,
  mobileColumn,
  onMobileColumn,
  compact = false,
  selectedId = null,
}: {
  /** Tarefas visíveis (já filtradas). */
  tasks: TaskDTO[];
  /** Todas as tarefas, para calcular posições mesmo com filtro. */
  allTasks: TaskDTO[];
  /** Painel da tarefa aberto ao lado (desktop): colunas com largura fixa e rolagem horizontal. */
  compact?: boolean;
  selectedId?: string | null;
  onOpen: (id: string) => void;
  onCreate: (status: TaskStatus) => void;
  mobileColumn: TaskStatus;
  onMobileColumn: (s: TaskStatus) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announce, setAnnounce] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef<{ id: string; pointerId: number; x: number; y: number; handle: boolean; el: HTMLElement; timer?: number } | null>(null);
  const suppressClick = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const cols = useMemo(() => {
    const out = {} as Record<TaskStatus, TaskDTO[]>;
    for (const s of TASK_STATUSES) out[s] = column(tasks, s);
    return out;
  }, [tasks]);

  /** Converte a posição entre as visíveis em posição entre todas (o filtro esconde algumas). */
  const toFullIndex = useCallback(
    (status: TaskStatus, visibleIndex: number, movingId: string) => {
      const visible = cols[status].filter((t) => t.id !== movingId);
      const full = column(allTasks, status).filter((t) => t.id !== movingId);
      if (visibleIndex >= visible.length) {
        const last = visible[visible.length - 1];
        return last ? full.findIndex((t) => t.id === last.id) + 1 : full.length;
      }
      const target = visible[visibleIndex]!;
      return Math.max(0, full.findIndex((t) => t.id === target.id));
    },
    [cols, allTasks],
  );

  const doMove = useCallback(
    (id: string, status: TaskStatus, visibleIndex: number | "top" | "bottom") => {
      const t = allTasks.find((x) => x.id === id);
      if (!t) return;
      const index =
        visibleIndex === "top" ? 0 : visibleIndex === "bottom" ? column(allTasks, status).filter((x) => x.id !== id).length : toFullIndex(status, visibleIndex, id);
      moveTask(id, status, index)
        .then((u) => {
          if (u.length && t.status !== status) setAnnounce(`#${t.number} foi para ${STATUS_LABEL[status]}.`);
          else if (u.length) setAnnounce(`#${t.number} mudou de posição.`);
        })
        .catch((err) => {
          toast.error(err);
          setAnnounce("Não foi possível mover. A tarefa voltou para onde estava.");
        });
    },
    [allTasks, toFullIndex],
  );

  const onKeyMove = useCallback(
    (id: string, dir: "up" | "down" | "left" | "right") => {
      const target = keyboardTarget(tasks, id, dir);
      if (!target) return;
      doMove(id, target.status, target.index);
      if (target.status !== allTasks.find((t) => t.id === id)?.status) onMobileColumn(target.status);
      // Mantém o foco na carta depois de ela trocar de lugar.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-open="${id}"]`)?.focus());
    },
    [tasks, allTasks, doMove, onMobileColumn],
  );

  // ---------- Arrastar ----------
  const computeOver = (x: number, y: number, id: string): DragState["over"] => {
    const els = document.elementsFromPoint(x, y) as HTMLElement[];
    const tab = els.map((e) => e.closest<HTMLElement>("[data-column-tab]")).find(Boolean);
    if (tab) return { status: tab.dataset.columnTab as TaskStatus, index: 0 };
    const col = els.map((e) => e.closest<HTMLElement>("[data-column]")).find(Boolean);
    if (!col) return null;
    const status = col.dataset.column as TaskStatus;
    const cards = [...col.querySelectorAll<HTMLElement>("[data-task-id]")].filter((c) => c.dataset.taskId !== id);
    let index = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y > r.top + r.height / 2) index++;
    }
    return { status, index };
  };

  const startDrag = (p: NonNullable<typeof pending.current>, x: number, y: number) => {
    const r = p.el.getBoundingClientRect();
    try {
      p.el.setPointerCapture(p.pointerId);
    } catch {
      /* alguns navegadores recusam captura em elementos que saem do DOM */
    }
    const next: DragState = { id: p.id, pointerId: p.pointerId, x, y, dx: p.x - r.left, dy: p.y - r.top, width: r.width, height: r.height, over: null };
    next.over = computeOver(x, y, p.id);
    setDrag(next);
    navigator.vibrate?.(8);
  };

  const onPointerDownCard = (e: ReactPointerEvent<HTMLElement>, task: TaskDTO, handle: boolean) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!handle && e.pointerType !== "mouse") return; // toque: só pela alça
    if (!handle && target.closest("button[aria-label], a, input, textarea")) return;
    const el = (e.currentTarget.closest("[data-task-id]") as HTMLElement | null) ?? e.currentTarget;
    pending.current = { id: task.id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, handle, el };
    if (handle) {
      e.preventDefault();
      startDrag(pending.current, e.clientX, e.clientY);
    }
  };

  useEffect(() => {
    let raf = 0;
    const autoScroll = (x: number, y: number) => {
      cancelAnimationFrame(raf);
      const els = document.elementsFromPoint(x, y) as HTMLElement[];
      const list = els.map((e) => e.closest<HTMLElement>("[data-column-scroll]")).find(Boolean);
      const board = document.querySelector<HTMLElement>("[data-board-scroll]");
      const step = () => {
        let moved = false;
        if (list) {
          const r = list.getBoundingClientRect();
          if (y < r.top + 48) (list.scrollTop -= 14), (moved = true);
          else if (y > r.bottom - 48) (list.scrollTop += 14), (moved = true);
        }
        if (board) {
          const r = board.getBoundingClientRect();
          if (x < r.left + 40) (board.scrollLeft -= 14), (moved = true);
          else if (x > r.right - 40) (board.scrollLeft += 14), (moved = true);
        }
        if (moved && dragRef.current) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      const d = dragRef.current;
      if (d) {
        if (e.pointerId !== d.pointerId) return;
        e.preventDefault();
        const over = computeOver(e.clientX, e.clientY, d.id);
        setDrag({ ...d, x: e.clientX, y: e.clientY, over });
        autoScroll(e.clientX, e.clientY);
        return;
      }
      if (p && e.pointerId === p.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) startDrag(p, e.clientX, e.clientY);
    };
    const finish = (e: PointerEvent, cancel: boolean) => {
      const d = dragRef.current;
      pending.current = null;
      if (!d || e.pointerId !== d.pointerId) return;
      cancelAnimationFrame(raf);
      setDrag(null);
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (!cancel && d.over) {
        doMove(d.id, d.over.status, d.over.index);
        onMobileColumn(d.over.status);
      }
    };
    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) {
        e.stopPropagation();
        pending.current = null;
        setDrag(null);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [doMove, onMobileColumn]);

  // Enquanto arrasta, a página não seleciona texto nem rola sozinha no toque.
  useEffect(() => {
    if (!drag) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.classList.add("tb-dragging");
    return () => {
      document.body.style.userSelect = prev;
      document.body.classList.remove("tb-dragging");
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Com o painel aberto, o quadro encolhe e rola: traz a coluna da tarefa aberta para a vista.
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedStatus = selectedId ? allTasks.find((t) => t.id === selectedId)?.status : undefined;
  useEffect(() => {
    if (!compact || !selectedStatus) return;
    const col = scrollRef.current?.querySelector<HTMLElement>(`[data-column="${selectedStatus}"]`)?.closest("section");
    col?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [compact, selectedStatus]);
  // Sombra na borda direita quando há colunas escondidas: deixa claro que o quadro rola.
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [compact, tasks.length]);

  const open = (id: string) => {
    if (suppressClick.current) return;
    onOpen(id);
  };
  const dragged = drag ? allTasks.find((t) => t.id === drag.id) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Abas no celular: uma coluna por vez. Também aceitam soltar uma carta. */}
      <div role="tablist" aria-label="Colunas" className="flex gap-1 border-b border-line bg-surface px-2 md:hidden">
        {TASK_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={mobileColumn === s}
            data-column-tab={s}
            onClick={() => onMobileColumn(s)}
            className={cn(
              "-mb-px flex min-h-11 flex-1 flex-col items-center justify-center border-b-2 px-1 text-xs font-medium",
              mobileColumn === s ? "border-primary text-ink" : "border-transparent text-muted",
              drag?.over?.status === s && "bg-primary-soft",
            )}
          >
            <span className="truncate">{STATUS_LABEL[s]}</span>
            <span className="tabular-nums text-subtle">{cols[s].length}</span>
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        data-board-scroll
        className={cn(
          "tb-scroll flex min-h-0 flex-1 gap-3 overflow-x-auto overscroll-x-contain p-3 md:p-4",
          moreRight && "md:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]",
        )}
      >
        {TASK_STATUSES.map((s) => {
          const list = cols[s];
          const over = drag?.over?.status === s ? drag.over.index : null;
          const visible = list.filter((t) => t.id !== drag?.id || drag.over?.status !== s);
          return (
            <section
              key={s}
              aria-labelledby={`col-${s}`}
              className={cn(
                "flex min-h-0 min-w-0 flex-col rounded-xl bg-surface-2/70 md:shrink-0",
                compact ? "md:w-52 md:min-w-52" : "md:w-[min(19rem,calc((100%-2.25rem)/4))] md:min-w-60 lg:flex-1",
                mobileColumn === s ? "max-md:flex max-md:w-full" : "max-md:hidden",
                over !== null && "ring-2 ring-primary/50",
              )}
            >
              <header className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                <span className={cn("size-2 rounded-full", STATUS_DOT[s])} aria-hidden />
                <h2 id={`col-${s}`} className="min-w-0 truncate text-sm font-semibold">
                  {STATUS_LABEL[s]}
                </h2>
                <span className="text-xs text-subtle tabular-nums">{list.length}</span>
                <span className="flex-1" />
                <IconButton size="sm" label={`Nova tarefa em ${STATUS_LABEL[s]}`} onClick={() => onCreate(s)} className="size-7 max-md:size-10">
                  <Plus className="size-4" />
                </IconButton>
              </header>
              <div data-column={s} data-column-scroll className="tb-scroll flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                {visible.map((t, i) => (
                  <div key={t.id} className="flex flex-col gap-2">
                    {over === i && <DropSlot height={drag!.height} />}
                    <TaskCard task={t} onOpen={open} onMove={doMove} onKeyMove={onKeyMove} onPointerDownCard={onPointerDownCard} dragging={drag?.id === t.id} now={now} />
                  </div>
                ))}
                {over !== null && over >= visible.filter((t) => t.id !== drag?.id).length && <DropSlot height={drag!.height} />}
                {list.length === 0 && over === null && (
                  <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-subtle">
                    {s === "done" ? "Nada concluído ainda." : "Nenhuma tarefa aqui."}
                    <span className="max-md:hidden"> Arraste uma carta para cá.</span>
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {drag && dragged && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rotate-[1.5deg] rounded-lg border border-primary bg-elevated px-3 py-2.5 shadow-pop"
          style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width }}
        >
          <span className="text-[11px] text-subtle">#{dragged.number}</span>
          <span className="block text-sm font-medium">{dragged.title}</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

function DropSlot({ height }: { height: number }) {
  return <div aria-hidden className="rounded-lg border-2 border-dashed border-primary/60 bg-primary-soft/40" style={{ height: Math.min(height, 140) }} />;
}
