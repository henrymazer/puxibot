import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AtSign, Bell, CircleCheckBig, MessageSquare, PlugZap, TriangleAlert, Wallet } from "lucide-react";
import type { NotificationDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { Popover } from "../../components/Popover";
import { Button, EmptyState, ErrorState, IconButton, LoadingState } from "../../components/ui";
import { resolveLink } from "../../lib/paths";
import { formatRelative } from "../../lib/format";
import { errorMessage } from "../../api";
import { toast } from "../../components/toast";
import { cn } from "../../lib/cn";
import { useWsId } from "./hooks";

const ICON: Record<NotificationDTO["kind"], typeof Bell> = {
  mention: AtSign,
  dm: MessageSquare,
  approval: CircleCheckBig,
  budget: Wallet,
  job_failed: TriangleAlert,
  no_runner: PlugZap,
};

export function NotificationsBell() {
  const ws = useWsId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const unread = useWorkspace((s) => s.unreadNotifications);
  const items = useWorkspace((s) => s.notifications);
  const loaded = useWorkspace((s) => s.notificationsLoaded);
  const loadNotifications = useWorkspace((s) => s.loadNotifications);
  const markRead = useWorkspace((s) => s.markNotificationsRead);
  const navigate = useNavigate();

  const load = () => {
    setError(null);
    loadNotifications().catch((e) => setError(errorMessage(e)));
  };
  useEffect(() => {
    if (open && !loaded) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);

  const openItem = (n: NotificationDTO) => {
    if (!n.read) markRead([n.id]).catch(() => undefined);
    const to = resolveLink(ws, n.link);
    setOpen(false);
    if (to) navigate(to);
  };

  return (
    <>
      <span className="relative">
        <IconButton ref={anchor} label={unread ? `Notificações, ${unread} novas` : "Notificações"} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Bell className="size-4.5" />
        </IconButton>
        {unread > 0 && (
          <span className="pointer-events-none absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-new px-1 text-[10px] font-bold text-white dark:text-[#1b1e24]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Notificações" className="w-[360px] max-md:w-auto">
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-elevated px-4 py-2.5">
          <h2 className="text-sm font-semibold">Notificações</h2>
          <Button size="sm" variant="ghost" disabled={!items.some((n) => !n.read)} onClick={() => markRead().catch(toast.error)}>
            Marcar todas como lidas
          </Button>
        </div>
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !loaded ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState icon={<Bell className="size-5" />} title="Tudo em dia">
            Menções, aprovações e avisos dos agentes aparecem aqui.
          </EmptyState>
        ) : (
          <ul className="py-1">
            {items.map((n) => {
              const Icon = ICON[n.kind] ?? Bell;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => openItem(n)}
                    className={cn("flex w-full gap-3 px-4 py-2.5 text-left hover:bg-surface-2", !n.read && "bg-primary-soft/40")}
                  >
                    <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", n.kind === "job_failed" ? "bg-danger-soft text-danger" : "bg-surface-2 text-muted")}>
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-sm", !n.read && "font-semibold")}>{n.title}</span>
                      {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                      <span className="block text-xs text-subtle">{formatRelative(n.createdAt)}</span>
                    </span>
                    {!n.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Não lida" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Popover>
    </>
  );
}
