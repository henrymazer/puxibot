import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { useWorkspace } from "../../store/workspace";
import { rememberWorkspace, useSession } from "../../store/session";
import { Button, ErrorState, LoadingState } from "../../components/ui";
import { paths } from "../../lib/paths";
import { Sidebar } from "./Sidebar";
import { QuickSwitcher } from "./QuickSwitcher";
import { ShellContext, useWsId } from "./hooks";
import { lazyNamed } from "../../lib/lazy";
import { useNewTask } from "../tasks/newTask";

const AgentProfileHost = lazyNamed(() => import("../agents/AgentProfile"), "AgentProfileHost");
const NewTaskHost = lazyNamed(() => import("../tasks/NewTaskDialog"), "NewTaskHost");

export function AppShell() {
  const ws = useWsId();
  const workspaces = useSession((s) => s.workspaces);
  const status = useWorkspace((s) => s.status);
  const error = useWorkspace((s) => s.error);
  const load = useWorkspace((s) => s.load);
  const [navOpen, setNavOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const location = useLocation();
  const known = workspaces.some((w) => w.id === ws);
  const [params] = useSearchParams();
  const hasAgentParam = params.has("agente");
  const newTaskOpen = useNewTask((s) => s.prefill !== null);

  useEffect(() => {
    if (!known) return;
    rememberWorkspace(ws);
    void load(ws);
  }, [ws, known, load]);

  useEffect(() => () => useWorkspace.getState().dispose(), []);

  // Fecha a gaveta ao navegar.
  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openNav = useCallback(() => setNavOpen(true), []);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
  const ctx = useMemo(() => ({ openNav, closeNav, openSwitcher }), [openNav, closeNav, openSwitcher]);

  if (!known) return <Navigate to="/" replace />;

  return (
    <ShellContext.Provider value={ctx}>
      <div className="flex h-dvh w-full overflow-hidden bg-bg">
        {/* Barra lateral fixa no desktop */}
        <aside className="hidden w-[var(--tb-sidebar-w)] shrink-0 border-r border-line md:flex">
          <Sidebar />
        </aside>
        {/* Gaveta no celular */}
        {navOpen && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navegação">
            <div className="tb-anim-fade absolute inset-0 bg-[var(--tb-overlay)]" onClick={closeNav} aria-hidden />
            <aside className="tb-anim-drawer absolute inset-y-0 left-0 flex w-[min(86vw,320px)] shadow-pop">
              <Sidebar onNavigate={closeNav} autoFocus />
            </aside>
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {status === "ready" && <TooManyConnectionsBanner />}
          {status === "error" ? (
            <ErrorState message={error ?? ""} onRetry={() => void load(ws)} className="mt-24" />
          ) : status !== "ready" ? (
            <LoadingState label="Carregando o workspace…" className="h-full" />
          ) : (
            <Outlet />
          )}
        </main>
      </div>
      {status === "ready" && <QuickSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />}
      {status === "ready" && newTaskOpen && (
        <Suspense fallback={null}>
          <NewTaskHost />
        </Suspense>
      )}
      {status === "ready" && hasAgentParam && (
        <Suspense fallback={null}>
          <AgentProfileHost />
        </Suspense>
      )}
    </ShellContext.Provider>
  );
}

/** O hub fechou esta aba com 4008: há conexões demais abertas pela mesma pessoa. Não reconecta sozinha. */
function TooManyConnectionsBanner() {
  const connection = useWorkspace((s) => s.connection);
  const reconnect = useWorkspace((s) => s.reconnect);
  if (connection !== "too_many") return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/40 bg-warning-soft px-4 py-2.5 text-sm">
      <p className="min-w-0 flex-1">
        Esta aba parou de receber atualizações porque você tem conexões demais abertas (outras abas ou aparelhos). Feche as que não usa e
        reconecte.
      </p>
      <Button size="sm" onClick={reconnect}>
        Reconectar
      </Button>
    </div>
  );
}

export function RedirectToWorkspace() {
  const ws = useWsId();
  return <Navigate to={paths.workspace(ws)} replace />;
}
