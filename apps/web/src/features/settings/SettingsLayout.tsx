import { Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { LoadingState } from "../../components/ui";
import { Bell, Building2, KeyRound, Laptop, LockKeyhole, MessagesSquare, Plug, Settings, Sparkles, UserRound } from "lucide-react";
import { PageHeader } from "../shell/PageHeader";
import { useWsId } from "../shell/hooks";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";

const SECTIONS = [
  { id: "perfil", label: "Perfil", icon: UserRound },
  { id: "notificacoes", label: "Notificações", icon: Bell },
  { id: "computadores", label: "Computadores", icon: Laptop },
  { id: "tokens", label: "Tokens pessoais", icon: KeyRound },
  { id: "workspace", label: "Workspace", icon: Building2 },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "conectores", label: "Conectores", icon: Plug },
  { id: "canais", label: "Canais de conversa", icon: MessagesSquare },
  { id: "cofre", label: "Cofre", icon: LockKeyhole },
];

export function SettingsLayout() {
  const ws = useWsId();
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader title="Configurações" icon={<Settings className="size-5" />} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Seções das configurações"
          className="tb-scroll shrink-0 overflow-x-auto border-b border-line bg-surface md:w-56 md:overflow-x-visible md:border-r md:border-b-0 md:bg-transparent md:p-3"
        >
          <ul className="flex gap-1 px-2 py-1.5 md:flex-col md:p-0">
            {SECTIONS.map((s) => (
              <li key={s.id} className="shrink-0">
                <NavLink
                  to={paths.settings(ws, s.id)}
                  className={({ isActive }) =>
                    cn(
                      "flex h-10 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap md:h-9",
                      isActive ? "bg-primary-soft font-medium text-primary-text" : "text-muted hover:bg-surface-2 hover:text-ink",
                    )
                  }
                >
                  <s.icon className="size-4" aria-hidden />
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:px-6">
            <Suspense fallback={<LoadingState />}>
              <Outlet />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
