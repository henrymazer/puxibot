import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { CircleCheckBig, FileText, Hash, Lock, MessageSquareText, Search, Settings, Users } from "lucide-react";
import type { MessageDTO, SearchResultsDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { api, errorMessage } from "../../api";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { actorName, channelLabel } from "../../lib/actors";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Spinner } from "../../components/ui";
import { toast } from "../../components/toast";
import { useWsId } from "./hooks";

interface Item {
  key: string;
  group: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

function norm(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWsId();
  const navigate = useNavigate();
  const channels = useWorkspace((s) => s.channels);
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  const openDm = useWorkspace((s) => s.openDm);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<SearchResultsDTO | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (open) {
      setQ("");
      setRemote(null);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setRemote(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .search(ws, term)
        .then((r) => {
          setRemote(r);
          setSearchError(null);
        })
        .catch((e) => setSearchError(errorMessage(e)))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, ws]);

  const items = useMemo<Item[]>(() => {
    const term = norm(q.trim());
    const match = (...s: (string | null | undefined)[]) => !term || s.some((x) => x && norm(x).includes(term));
    const go = (to: string) => () => navigate(to);
    const out: Item[] = [];
    const state = { members, agents, myUserId };
    for (const c of Object.values(channels)) {
      if (c.kind !== "channel") continue;
      if (!match(c.name, c.topic)) continue;
      out.push({
        key: `c:${c.id}`,
        group: "Canais",
        label: c.name ?? "",
        detail: c.section ?? undefined,
        icon: c.isPrivate ? <Lock className="size-4" /> : <Hash className="size-4" />,
        run: go(paths.channel(ws, c.id)),
      });
    }
    for (const a of Object.values(agents)) {
      if (!match(a.name, a.handle, a.role)) continue;
      out.push({
        key: `a:${a.id}`,
        group: "Agentes",
        label: a.name,
        detail: `@${a.handle}${a.role ? ` · ${a.role}` : ""}`,
        icon: <AgentAvatar agent={a} size="xs" />,
        run: async () => {
          const ch = await openDm({ type: "agent", id: a.id });
          navigate(paths.channel(ws, ch.id));
        },
      });
    }
    for (const m of Object.values(members)) {
      if (!match(m.name, m.email, m.title)) continue;
      out.push({
        key: `u:${m.userId}`,
        group: "Pessoas",
        label: m.userId === myUserId ? `${m.name} (você)` : m.name,
        detail: m.title ?? m.email,
        icon: <PersonAvatar member={m} size="xs" presence={m.online} />,
        run: async () => {
          const ch = await openDm({ type: "user", id: m.userId });
          navigate(paths.channel(ws, ch.id));
        },
      });
    }
    const pages: [string, string, ReactNode][] = [
      ["Início", paths.workspace(ws), <Users className="size-4" key="h" />],
      ["Equipe", paths.team(ws), <Users className="size-4" key="t" />],
      ["Tarefas", paths.tasks(ws), <FileText className="size-4" key="k" />],
      ["Wiki", paths.wiki(ws), <FileText className="size-4" key="w" />],
      ["Drive", paths.drive(ws), <FileText className="size-4" key="d" />],
      ["Rotinas", paths.routines(ws), <Settings className="size-4" key="r" />],
      ["Notificações", paths.settings(ws, "notificacoes"), <Settings className="size-4" key="n" />],
      ["Skills", paths.settings(ws, "skills"), <Settings className="size-4" key="sk" />],
      ["Conectores", paths.settings(ws, "conectores"), <Settings className="size-4" key="co" />],
      ["Aprovações", paths.approvals(ws), <CircleCheckBig className="size-4" key="a" />],
      ["Configurações", paths.settings(ws), <Settings className="size-4" key="s" />],
      ["Computadores", paths.settings(ws, "computadores"), <Settings className="size-4" key="c" />],
    ];
    for (const [label, to, icon] of pages) if (match(label)) out.push({ key: `p:${to}`, group: "Telas", label, icon, run: go(to) });

    const limited: Item[] = [];
    const perGroup: Record<string, number> = {};
    for (const it of out) {
      perGroup[it.group] = (perGroup[it.group] ?? 0) + 1;
      if (perGroup[it.group]! <= (term ? 6 : 4)) limited.push(it);
    }
    if (remote) {
      for (const m of remote.messages.slice(0, 8)) {
        const ch = channels[m.channelId];
        limited.push({
          key: `m:${m.id}`,
          group: "Mensagens",
          label: snippet(m),
          detail: `${actorName(state, m.author)}${ch ? ` em ${ch.kind === "dm" ? channelLabel(state, ch) : `#${ch.name}`}` : ""}`,
          icon: <MessageSquareText className="size-4" />,
          run: go(m.threadRootId ? paths.thread(ws, m.channelId, m.threadRootId) : paths.channel(ws, m.channelId)),
        });
      }
      for (const f of remote.files.slice(0, 4)) {
        limited.push({ key: `f:${f.id}`, group: "Arquivos", label: f.name, icon: <FileText className="size-4" />, run: go(`${paths.drive(ws)}?arquivo=${encodeURIComponent(f.id)}`) });
      }
      for (const t of remote.tasks.slice(0, 4)) {
        limited.push({ key: `t:${t.id}`, group: "Tarefas", label: `#${t.number} ${t.title}`, icon: <FileText className="size-4" />, run: go(paths.tasks(ws, t.id)) });
      }
      for (const p of remote.wikiPages.slice(0, 4)) {
        limited.push({ key: `w:${p.id}`, group: "Wiki", label: p.title, icon: <FileText className="size-4" />, run: go(paths.wiki(ws, p.id)) });
      }
    }
    return limited;
  }, [q, channels, members, agents, myUserId, remote, ws, navigate, openDm]);

  useEffect(() => setActive(0), [q]);

  if (!open) return null;

  const run = async (it: Item | undefined) => {
    if (!it) return;
    try {
      await it.run();
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };

  let lastGroup = "";
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center md:pt-[12vh]">
      <div className="tb-anim-fade absolute inset-0 bg-[var(--tb-overlay)]" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ir para"
        className="tb-anim-pop relative flex w-full flex-col overflow-hidden bg-elevated shadow-pop max-md:h-full max-md:pt-[env(safe-area-inset-top)] md:max-h-[70vh] md:max-w-xl md:rounded-xl md:border md:border-line"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(items.length - 1, i + 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          }
          if (e.key === "Enter") {
            e.preventDefault();
            void run(items[active]);
          }
          if (e.key === "Tab") e.preventDefault();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-muted" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar canais, pessoas, agentes e mensagens"
            className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-subtle"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
            aria-label="Buscar"
          />
          {searching && <Spinner label="Buscando" />}
          <button type="button" onClick={onClose} className="text-sm text-muted md:hidden">
            Fechar
          </button>
        </div>
        <ul id={listId} role="listbox" aria-label="Resultados" className="tb-scroll min-h-0 flex-1 overflow-y-auto py-1.5">
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.key} role="presentation">
                {header && <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => void run(it)}
                  className={cn("mx-1.5 flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 max-md:min-h-12", i === active && "bg-primary-soft")}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center text-muted">{it.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{it.label}</span>
                    {it.detail && <span className="block truncate text-xs text-muted">{it.detail}</span>}
                  </span>
                </div>
              </li>
            );
          })}
          {items.length === 0 && !searching && <li className="px-4 py-8 text-center text-sm text-muted">Nada encontrado para “{q}”.</li>}
          {searchError && <li className="px-4 py-2 text-xs text-danger">Busca de mensagens indisponível: {searchError}</li>}
        </ul>
        <div className="hidden border-t border-line px-4 py-2 text-xs text-subtle md:block">
          ↑↓ para navegar · Enter para abrir · Esc para fechar
        </div>
      </div>
    </div>,
    document.body,
  );
}

function snippet(m: MessageDTO): string {
  const s = m.body.replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s || "(mensagem sem texto)";
}
