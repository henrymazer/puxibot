import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import type { ActorRef } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { cn } from "../../lib/cn";

const keyOf = (a: ActorRef) => `${a.type}:${a.id}`;

/** Lista pesquisável de pessoas e agentes. `multiple` mostra caixas de seleção. */
export function ActorPicker({
  selected,
  onToggle,
  exclude = [],
  includeAgents = true,
  includeMe = false,
  multiple = true,
  autoFocus,
}: {
  selected: ActorRef[];
  onToggle: (a: ActorRef) => void;
  exclude?: ActorRef[];
  includeAgents?: boolean;
  includeMe?: boolean;
  multiple?: boolean;
  autoFocus?: boolean;
}) {
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  const [q, setQ] = useState("");
  const sel = new Set(selected.map(keyOf));
  const ex = new Set(exclude.map(keyOf));

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out: { ref: ActorRef; name: string; detail: string | null }[] = [];
    if (includeAgents)
      for (const a of Object.values(agents)) out.push({ ref: { type: "agent", id: a.id }, name: a.name, detail: `@${a.handle}${a.role ? ` · ${a.role}` : ""}` });
    for (const m of Object.values(members)) {
      if (!includeMe && m.userId === myUserId) continue;
      out.push({ ref: { type: "user", id: m.userId }, name: m.userId === myUserId ? `${m.name} (você)` : m.name, detail: m.title ?? m.email });
    }
    return out
      .filter((r) => !ex.has(keyOf(r.ref)))
      .filter((r) => !term || r.name.toLowerCase().includes(term) || (r.detail ?? "").toLowerCase().includes(term));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, members, agents, includeAgents, includeMe, myUserId, exclude]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <label className="relative block">
        <span className="sr-only">Buscar pessoas e agentes</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden />
        <input className="tb-input pl-9" placeholder="Buscar pessoas e agentes" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} />
      </label>
      <ul className="tb-scroll max-h-72 min-h-0 overflow-y-auto rounded-md border border-line" role="listbox" aria-multiselectable={multiple}>
        {rows.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">Ninguém encontrado.</li>}
        {rows.map((r) => {
          const on = sel.has(keyOf(r.ref));
          const agent = r.ref.type === "agent" ? agents[r.ref.id] : undefined;
          const member = r.ref.type === "user" ? members[r.ref.id] : undefined;
          return (
            <li key={keyOf(r.ref)} role="option" aria-selected={on}>
              <button type="button" onClick={() => onToggle(r.ref)} className={cn("flex min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-2", on && "bg-primary-soft/60")}>
                {multiple && (
                  <span className={cn("flex size-4.5 shrink-0 items-center justify-center rounded-xs border", on ? "border-primary bg-primary text-primary-fg" : "border-line-strong")} aria-hidden>
                    {on && <Check className="size-3.5" />}
                  </span>
                )}
                {agent ? <AgentAvatar agent={agent} size="sm" /> : <PersonAvatar member={member} size="sm" presence={member?.online} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  {r.detail && <span className="block truncate text-xs text-muted">{r.detail}</span>}
                </span>
                {agent && <span className="rounded-xs bg-agent-soft px-1.5 text-[11px] font-medium text-agent">agente</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function toggleIn(list: ActorRef[], a: ActorRef): ActorRef[] {
  return list.some((x) => x.type === a.type && x.id === a.id) ? list.filter((x) => !(x.type === a.type && x.id === a.id)) : [...list, a];
}
