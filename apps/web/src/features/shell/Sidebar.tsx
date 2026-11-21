import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, useMatch } from "react-router-dom";
import {
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleCheckBig,
  FolderOpen,
  Hash,
  House,
  KanbanSquare,
  Lock,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
  Users,
  WifiOff,
  UserRound,
} from "lucide-react";
import type { ChannelDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { channelLabel, dmPeer } from "../../lib/actors";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { IconButton, Kbd, UnreadCount } from "../../components/ui";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { NotificationsBell } from "./NotificationsBell";
import { useShell, useWsId } from "./hooks";
import { CreateChannelDialog } from "../chat/CreateChannelDialog";
import { NewDmDialog } from "../chat/NewDmDialog";

const COLLAPSE_KEY = "tb-collapsed-sections";

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  const toggle = (k: string) =>
    setCollapsed((c) => {
      const n = { ...c, [k]: !c[k] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  return { collapsed, toggle };
}

export function Sidebar({ onNavigate, autoFocus }: { onNavigate?: () => void; autoFocus?: boolean }) {
  const ws = useWsId();
  const channels = useWorkspace((s) => s.channels);
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  const me = useWorkspace((s) => s.me);
  const approvals = useWorkspace((s) => s.approvals);
  const connection = useWorkspace((s) => s.connection);
  const { openSwitcher } = useShell();
  const { collapsed, toggle } = useCollapsed();
  const [createChannel, setCreateChannel] = useState<{ section?: string } | null>(null);
  const [newDm, setNewDm] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) rootRef.current?.querySelector<HTMLElement>("button,a")?.focus();
  }, [autoFocus]);

  const { sections, dms } = useMemo(() => {
    const list = Object.values(channels);
    const bySection = new Map<string, ChannelDTO[]>();
    for (const c of list.filter((c) => c.kind === "channel")) {
      const k = c.section?.trim() || "";
      if (!bySection.has(k)) bySection.set(k, []);
      bySection.get(k)!.push(c);
    }
    const sections = [...bySection.entries()]
      .map(([name, items]) => ({ name, items: items.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "pt-BR")) }))
      .sort((a, b) => (a.name === "" ? -1 : b.name === "" ? 1 : a.name.localeCompare(b.name, "pt-BR")));
    const dms = list
      .filter((c) => c.kind === "dm")
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    return { sections, dms };
  }, [channels]);

  const pendingApprovals = Object.values(approvals).filter((a) => a.approverUserId === myUserId || me?.role !== "member").length;
  const label = (c: ChannelDTO) => channelLabel({ members, agents, myUserId }, c);

  return (
    <div ref={rootRef} className="flex h-full w-full flex-col bg-sidebar pt-[env(safe-area-inset-top)] text-ink">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <WorkspaceMenu />
        <NotificationsBell />
      </div>
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            openSwitcher();
          }}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm text-muted hover:border-line-strong max-md:h-11"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 text-left">Ir para…</span>
          <span className="hidden md:inline">
            <Kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</Kbd> <Kbd>K</Kbd>
          </span>
        </button>
      </div>

      <nav aria-label="Navegação do workspace" className="tb-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ul className="space-y-px">
          <NavItem to={paths.workspace(ws)} end icon={<House className="size-4" />} label="Início" onNavigate={onNavigate} />
          <NavItem to={paths.approvals(ws)} icon={<CircleCheckBig className="size-4" />} label="Aprovações" count={pendingApprovals} onNavigate={onNavigate} />
          <NavItem to={paths.team(ws)} icon={<Users className="size-4" />} label="Equipe" onNavigate={onNavigate} />
          <NavItem to={paths.tasks(ws)} icon={<KanbanSquare className="size-4" />} label="Tarefas" onNavigate={onNavigate} />
          <NavItem to={paths.wiki(ws)} icon={<BookOpen className="size-4" />} label="Wiki" onNavigate={onNavigate} />
          <NavItem to={paths.drive(ws)} icon={<FolderOpen className="size-4" />} label="Drive" onNavigate={onNavigate} />
        </ul>

        {sections.map((s) => {
          const key = `s:${s.name}`;
          const unread = s.items.reduce((n, c) => n + c.unread, 0);
          return (
            <SidebarSection
              key={key}
              title={s.name || "Canais"}
              collapsed={!!collapsed[key]}
              onToggle={() => toggle(key)}
              unread={unread}
              onAdd={() => setCreateChannel({ section: s.name || undefined })}
              addLabel={`Criar canal em ${s.name || "Canais"}`}
            >
              {s.items.map((c) =>
                !collapsed[key] || c.unread > 0 ? (
                  <ChannelLink key={c.id} ws={ws} channel={c} onNavigate={onNavigate}>
                    {c.isPrivate ? <Lock className="size-3.5 shrink-0 text-muted" aria-label="Privado" /> : <Hash className="size-3.5 shrink-0 text-muted" aria-hidden />}
                    <span className="truncate">{label(c)}</span>
                    {c.humansOnly && <UserRound className="size-3 shrink-0 text-subtle" aria-label="Só pessoas" />}
                  </ChannelLink>
                ) : null,
              )}
            </SidebarSection>
          );
        })}
        {sections.length === 0 && (
          <SidebarSection title="Canais" collapsed={false} onToggle={() => undefined} onAdd={() => setCreateChannel({})} addLabel="Criar canal">
            <li className="px-2 py-1 text-xs text-muted">Nenhum canal ainda.</li>
          </SidebarSection>
        )}

        <SidebarSection
          title="Mensagens diretas"
          collapsed={!!collapsed.dms}
          onToggle={() => toggle("dms")}
          unread={dms.reduce((n, c) => n + c.unread, 0)}
          onAdd={() => setNewDm(true)}
          addLabel="Nova conversa"
        >
          {dms.map((c) => {
            if (collapsed.dms && c.unread === 0) return null;
            const peer = dmPeer(c, myUserId);
            const agent = peer?.type === "agent" ? agents[peer.id] : undefined;
            const member = peer?.type === "user" ? members[peer.id] : undefined;
            return (
              <ChannelLink key={c.id} ws={ws} channel={c} onNavigate={onNavigate}>
                {agent ? (
                  <AgentAvatar agent={agent} size="xs" showActivity />
                ) : (
                  <PersonAvatar member={member} name={label(c)} size="xs" presence={member?.online ?? false} />
                )}
                <span className="truncate">{label(c)}</span>
                {peer?.type === "user" && peer.id === myUserId && <span className="text-xs text-subtle">(você)</span>}
                {agent && agent.activity === "working" && <span className="sr-only">trabalhando</span>}
              </ChannelLink>
            );
          })}
          {dms.length === 0 && !collapsed.dms && <li className="px-2 py-1 text-xs text-muted">Converse com uma pessoa ou agente.</li>}
        </SidebarSection>

        <div className="mt-4 mb-1 px-2 text-[11px] font-semibold tracking-wide text-subtle uppercase">Automação</div>
        <ul className="space-y-px">
          <NavItem to={paths.routines(ws)} icon={<CalendarClock className="size-4" />} label="Rotinas" onNavigate={onNavigate} />
          <NavItem to={paths.settings(ws, "skills")} icon={<Sparkles className="size-4" />} label="Skills" onNavigate={onNavigate} />
          <NavItem to={paths.settings(ws, "conectores")} icon={<Plug className="size-4" />} label="Conectores" onNavigate={onNavigate} />
        </ul>
      </nav>

      <div className="flex items-center gap-2 border-t border-line px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <NavLink
          to={paths.settings(ws, "perfil")}
          onClick={onNavigate}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-sidebar-hover"
        >
          <PersonAvatar member={me} size="sm" presence={connection === "online"} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{me?.name}</span>
            <span className="block truncate text-xs text-muted">{me?.statusText || (me?.runnerOnline ? "Computador ligado" : "Sem computador ligado")}</span>
          </span>
        </NavLink>
        {connection !== "online" && (
          <span className="flex items-center gap-1 text-xs text-warning" role="status" title={connection === "too_many" ? "Desconectado: conexões demais abertas" : "Reconectando ao servidor"}>
            <WifiOff className="size-4" aria-hidden />
            <span className="sr-only">{connection === "too_many" ? "Desconectado" : "Reconectando"}</span>
          </span>
        )}
        <NavLinkIcon to={paths.settings(ws)} label="Configurações" onNavigate={onNavigate}>
          <Settings className="size-4.5" />
        </NavLinkIcon>
      </div>

      {createChannel && (
        <CreateChannelDialog
          defaultSection={createChannel.section}
          onClose={() => setCreateChannel(null)}
          onCreated={() => {
            setCreateChannel(null);
            onNavigate?.();
          }}
        />
      )}
      {newDm && (
        <NewDmDialog
          onClose={() => setNewDm(false)}
          onOpened={() => {
            setNewDm(false);
            onNavigate?.();
          }}
        />
      )}
    </div>
  );
}

function NavLinkIcon({ to, label, children, onNavigate }: { to: string; label: string; children: ReactNode; onNavigate?: () => void }) {
  const active = useMatch({ path: to.replace(/\/perfil$/, ""), end: false });
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-sidebar-hover hover:text-ink max-md:size-11",
        active && "bg-sidebar-active text-sidebar-active-text",
      )}
    >
      {children}
    </NavLink>
  );
}

function NavItem({ to, icon, label, count, onNavigate, end }: { to: string; icon: ReactNode; label: string; count?: number; onNavigate?: () => void; end?: boolean }) {
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm max-md:h-11",
            isActive ? "bg-sidebar-active font-medium text-sidebar-active-text" : "text-ink/85 hover:bg-sidebar-hover",
          )
        }
      >
        <span className="text-muted">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {count ? <UnreadCount n={count} className="bg-agent text-white dark:text-[#1b1e24]" /> : null}
      </NavLink>
    </li>
  );
}

function SidebarSection({
  title,
  collapsed,
  onToggle,
  unread,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  unread?: number;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="group flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-sm px-1 text-[11px] font-semibold tracking-wide text-subtle uppercase hover:text-ink max-md:h-10"
        >
          {collapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
          <span className="truncate">{title}</span>
          {collapsed && unread ? <span className="ml-1 size-1.5 rounded-full bg-primary" aria-label={`${unread} não lidas`} /> : null}
        </button>
        {onAdd && (
          <IconButton label={addLabel ?? "Adicionar"} size="sm" onClick={onAdd} className="size-7 opacity-70 group-hover:opacity-100 max-md:size-10">
            <Plus className="size-4" />
          </IconButton>
        )}
      </div>
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

function ChannelLink({ ws, channel, children, onNavigate }: { ws: string; channel: ChannelDTO; children: ReactNode; onNavigate?: () => void }) {
  const unread = channel.unread;
  return (
    <li>
      <NavLink
        to={paths.channel(ws, channel.id)}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            "flex h-8 items-center gap-2 rounded-md px-2 text-sm max-md:h-11",
            isActive
              ? "bg-sidebar-active font-medium text-sidebar-active-text"
              : unread
                ? "font-semibold text-ink hover:bg-sidebar-hover"
                : "text-ink/80 hover:bg-sidebar-hover",
          )
        }
      >
        {children}
        <span className="flex-1" />
        <UnreadCount n={unread} />
      </NavLink>
    </li>
  );
}
