import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, LogOut, Monitor, Moon, Plus, Sun } from "lucide-react";
import { useSession } from "../../store/session";
import { useWorkspace } from "../../store/workspace";
import { useTheme, type ThemePref } from "../../lib/theme";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { MenuItem, Popover } from "../../components/Popover";
import { ROLE_LABEL } from "../../lib/actors";
import { toast } from "../../components/toast";

export function WorkspaceMark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-fg", className)}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "T"}
    </span>
  );
}

export function WorkspaceMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const workspaces = useSession((s) => s.workspaces);
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const current = useWorkspace((s) => s.workspace);
  const theme = useTheme();
  const navigate = useNavigate();

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left hover:bg-sidebar-hover"
      >
        <WorkspaceMark name={current?.name ?? "T"} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{current?.name}</span>
          <span className="block truncate text-xs text-muted">{current?.kind === "personal" ? "Individual" : "Equipe"}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Workspaces" className="w-80 py-1.5">
        <div className="px-3 pt-1 pb-1.5 text-xs text-muted">{user?.email}</div>
        <div role="menu" aria-label="Trocar de workspace">
          {workspaces.map((w) => (
            <MenuItem
              key={w.id}
              icon={<WorkspaceMark name={w.name} className="size-6 text-xs" />}
              onClick={() => go(paths.workspace(w.id))}
              trailing={w.id === current?.id ? <Check className="size-4 text-primary" aria-label="Atual" /> : <span className="text-xs text-subtle">{ROLE_LABEL[w.role]}</span>}
            >
              {w.name}
            </MenuItem>
          ))}
          <MenuItem icon={<Plus className="size-4" />} onClick={() => go(paths.newWorkspace)}>
            Criar workspace
          </MenuItem>
        </div>
        <div className="my-1.5 border-t border-line" />
        <div className="px-3 py-1 text-xs text-muted">Aparência</div>
        <div className="flex gap-1 px-3 pb-2" role="radiogroup" aria-label="Tema">
          {(
            [
              ["system", "Sistema", Monitor],
              ["light", "Claro", Sun],
              ["dark", "Escuro", Moon],
            ] as [ThemePref, string, typeof Sun][]
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={theme.pref === id}
              onClick={() => theme.set(id)}
              className={cn(
                "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-xs max-md:h-11",
                theme.pref === id ? "border-primary bg-primary-soft text-primary-text" : "border-line text-muted hover:bg-surface-2",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <div className="my-1.5 border-t border-line" />
        <MenuItem
          icon={<LogOut className="size-4" />}
          onClick={() => {
            setOpen(false);
            logout()
              .then(() => navigate(paths.login))
              .catch(toast.error);
          }}
        >
          Sair
        </MenuItem>
      </Popover>
    </>
  );
}
