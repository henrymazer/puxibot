/** Peças pequenas das tarefas: prioridade, etiquetas, responsável, aviso de parada e campo com @. */
import { forwardRef, useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { AlertTriangle, ChevronDown, CircleDashed, Flag, UserRound } from "lucide-react";
import type { ActorRef, TaskDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Popover } from "../../components/Popover";
import { ActorPicker } from "../chat/ActorPicker";
import { actorName} from "../../lib/actors";
import { memberHandle } from "../../lib/handles";
import { PRIORITY_LABEL, stalledDays } from "../../lib/kanban";
import { applyMention, filterMentionCandidates, getMentionQuery, type MentionCandidate, type MentionQuery } from "../../lib/mentions";
import { cn } from "../../lib/cn";

const PRIORITY_TONE: Record<TaskDTO["priority"], string> = {
  high: "text-danger",
  medium: "text-warning",
  low: "text-subtle",
};

export function PriorityIcon({ priority, withLabel }: { priority: TaskDTO["priority"]; withLabel?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", PRIORITY_TONE[priority])} title={`Prioridade ${PRIORITY_LABEL[priority].toLowerCase()}`}>
      <Flag className="size-3.5" aria-hidden fill={priority === "high" ? "currentColor" : "none"} />
      {withLabel ? PRIORITY_LABEL[priority] : <span className="sr-only">Prioridade {PRIORITY_LABEL[priority].toLowerCase()}</span>}
    </span>
  );
}

export function LabelChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm bg-primary-soft px-1.5 py-0.5 text-[11px] font-medium text-primary-text">
      <span className="truncate">{label}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Tirar etiqueta ${label}`} className="-mr-0.5 rounded-xs px-0.5 hover:bg-primary/15 max-md:px-1.5">
          ×
        </button>
      )}
    </span>
  );
}

export function ActorAvatar({ actor, size = "xs" }: { actor: ActorRef; size?: "xs" | "sm" | "md" }) {
  const agent = useWorkspace((s) => (actor.type === "agent" ? s.agents[actor.id] : undefined));
  const member = useWorkspace((s) => (actor.type === "user" ? s.members[actor.id] : undefined));
  if (actor.type === "agent") return <AgentAvatar agent={agent ?? { id: actor.id, name: "Agente", avatarColor: null, avatarAccessory: null }} size={size} showActivity={size !== "xs"} />;
  return <PersonAvatar member={member} name={member?.name ?? "?"} size={size} />;
}

export function useActorName() {
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  return (a: { type: string; id: string | null }) => actorName({ members, agents }, a);
}

/** Aviso "Parado há N dias". */
export function StalledNote({ task, now = Date.now(), className }: { task: TaskDTO; now?: number; className?: string }) {
  const days = stalledDays(task, now);
  if (!days) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-sm bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning", className)}>
      <AlertTriangle className="size-3" aria-hidden />
      Parado há {days} {days === 1 ? "dia" : "dias"}
    </span>
  );
}

/** Botão que abre a escolha de responsável (pessoa, agente ou ninguém). */
export function AssigneeButton({
  value,
  onChange,
  disabled,
  className,
  compact,
}: {
  value: ActorRef | null;
  onChange: (a: ActorRef | null) => void;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const name = useActorName();
  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `Responsável: ${name(value)}. Trocar` : "Escolher responsável"}
        className={cn(
          "inline-flex min-h-9 max-w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-sm hover:bg-surface-2 disabled:opacity-55 max-md:min-h-11",
          className,
        )}
      >
        {value ? <ActorAvatar actor={value} /> : <CircleDashed className="size-4 text-subtle" aria-hidden />}
        <span className={cn("min-w-0 truncate", !value && "text-muted")}>{value ? name(value) : compact ? "Ninguém" : "Sem responsável"}</span>
        {value?.type === "agent" && <span className="rounded-xs bg-agent-soft px-1 text-[10px] font-semibold text-agent uppercase">agente</span>}
        <ChevronDown className="ml-auto size-3.5 shrink-0 text-subtle" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Escolher responsável" className="w-80 p-2">
        <div className="flex flex-col gap-2 max-md:p-2">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn("flex min-h-10 items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-surface-2", !value && "bg-surface-2 font-medium")}
          >
            <UserRound className="size-4 text-subtle" aria-hidden />
            Sem responsável
          </button>
          <ActorPicker
            multiple={false}
            includeMe
            autoFocus
            selected={value ? [value] : []}
            onToggle={(a) => {
              onChange(a);
              setOpen(false);
            }}
          />
          <p className="px-1 text-xs text-muted">Atribuir a um agente pede que ele comece a trabalhar na tarefa.</p>
        </div>
      </Popover>
    </>
  );
}

/** Textarea com sugestão de @menções (pessoas e agentes). */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; onValue: (v: string) => void; onSubmit?: () => void }>(
  function MentionTextarea({ value, onValue, onSubmit, className, onKeyDown, ...rest }, ref) {
    const members = useWorkspace((s) => s.members);
    const agents = useWorkspace((s) => s.agents);
    const [mention, setMention] = useState<MentionQuery | null>(null);
    const [caret, setCaret] = useState(0);
    const [active, setActive] = useState(0);
    const inner = useRef<HTMLTextAreaElement | null>(null);
    const candidates = useMemo<MentionCandidate[]>(() => {
      const out: MentionCandidate[] = [];
      for (const a of Object.values(agents)) out.push({ type: "agent", id: a.id, handle: a.handle, name: a.name, detail: a.role });
      for (const m of Object.values(members)) out.push({ type: "user", id: m.userId, handle: memberHandle(m), name: m.name, detail: m.title });
      return out;
    }, [members, agents]);
    const suggestions = mention ? filterMentionCandidates(candidates, mention.query, 6) : [];

    const pick = (c: MentionCandidate) => {
      if (!mention) return;
      const next = applyMention(value, mention, caret, c.handle);
      onValue(next.text);
      setMention(null);
      requestAnimationFrame(() => {
        inner.current?.focus();
        inner.current?.setSelectionRange(next.caret, next.caret);
      });
    };
    const update = (el: HTMLTextAreaElement) => {
      const pos = el.selectionStart ?? el.value.length;
      setCaret(pos);
      setMention(getMentionQuery(el.value, pos));
      setActive(0);
    };
    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestions.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          pick(suggestions[active]!);
          return;
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          setMention(null);
          return;
        }
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
        e.preventDefault();
        onSubmit();
        return;
      }
      onKeyDown?.(e);
    };
    return (
      <div className="relative">
        <textarea
          ref={(el) => {
            inner.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          value={value}
          onChange={(e) => {
            onValue(e.target.value);
            update(e.target);
          }}
          onKeyDown={onKey}
          onClick={(e) => update(e.currentTarget)}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          className={cn("tb-input min-h-20 resize-y", className)}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          {...rest}
        />
        {suggestions.length > 0 && (
          <ul role="listbox" aria-label="Sugestões de menção" className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-md border border-line bg-elevated py-1 shadow-pop">
            {suggestions.map((c, i) => (
              <li key={`${c.type}:${c.id}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c)}
                  className={cn("flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm max-md:min-h-11", i === active && "bg-surface-2")}
                >
                  <ActorAvatar actor={{ type: c.type, id: c.id }} />
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="truncate text-xs text-subtle">@{c.handle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
