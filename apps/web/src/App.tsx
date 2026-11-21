import { Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useSession, lastWorkspace } from "./store/session";
import { ErrorState, LoadingState } from "./components/ui";
import { Toaster } from "./components/toast";
import { AppShell } from "./features/shell/AppShell";
import { NotFound } from "./features/shell/NotFound";
import { paths } from "./lib/paths";
import { lazyNamed } from "./lib/lazy";
import { isDemo } from "./api";
import { UpdateBanner } from "./pwa/UpdateBanner";

// Cada tela é um pedaço separado do pacote, carregado quando a rota abre.
const LoginPage = lazyNamed(() => import("./features/auth/AuthPages"), "LoginPage");
const SignupPage = lazyNamed(() => import("./features/auth/AuthPages"), "SignupPage");
const InvitePage = lazyNamed(() => import("./features/auth/InvitePage"), "InvitePage");
const CreateWorkspacePage = lazyNamed(() => import("./features/workspace/CreateWorkspacePage"), "CreateWorkspacePage");
const HomePage = lazyNamed(() => import("./features/home/HomePage"), "HomePage");
const ChannelPage = lazyNamed(() => import("./features/chat/ChannelPage"), "ChannelPage");
const TeamPage = lazyNamed(() => import("./features/team/TeamPage"), "TeamPage");
const ApprovalsPage = lazyNamed(() => import("./features/approvals/ApprovalsPage"), "ApprovalsPage");
const TasksPage = lazyNamed(() => import("./features/tasks/TasksPage"), "TasksPage");
const WikiPage = lazyNamed(() => import("./features/wiki/WikiPage"), "WikiPage");
const DrivePage = lazyNamed(() => import("./features/drive/DrivePage"), "DrivePage");
const RoutinesPage = lazyNamed(() => import("./features/routines/RoutinesPage"), "RoutinesPage");
const OnboardingPage = lazyNamed(() => import("./features/onboarding/OnboardingPage"), "OnboardingPage");
const SettingsLayout = lazyNamed(() => import("./features/settings/SettingsLayout"), "SettingsLayout");
const ProfileSettings = lazyNamed(() => import("./features/settings/ProfileSettings"), "ProfileSettings");
const ComputersSettings = lazyNamed(() => import("./features/settings/ComputersSettings"), "ComputersSettings");
const TokensSettings = lazyNamed(() => import("./features/settings/TokensSettings"), "TokensSettings");
const WorkspaceSettings = lazyNamed(() => import("./features/settings/WorkspaceSettings"), "WorkspaceSettings");
const SkillsSettings = lazyNamed(() => import("./features/settings/SkillsSettings"), "SkillsSettings");
const ConnectorsSettings = lazyNamed(() => import("./features/settings/ConnectorsSettings"), "ConnectorsSettings");
const NotificationsSettings = lazyNamed(() => import("./features/settings/NotificationsSettings"), "NotificationsSettings");
const PairPage = lazyNamed(() => import("./features/settings/PairPage"), "PairPage");

export function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingState className="h-full" />}>{children}</Suspense>;
}

function RequireAuth() {
  const status = useSession((s) => s.status);
  const error = useSession((s) => s.error);
  const load = useSession((s) => s.load);
  const location = useLocation();
  if (status === "loading") return <LoadingState label="Abrindo o Puxibot…" className="h-full" />;
  if (status === "error") return <ErrorState message={error ?? ""} onRetry={() => void load()} className="mt-24" />;
  if (status === "anon") {
    const next = location.pathname + location.search;
    return <Navigate to={`${paths.login}?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

function HomeRedirect() {
  const workspaces = useSession((s) => s.workspaces);
  if (workspaces.length === 0) return <Navigate to={paths.newWorkspace} replace />;
  const last = lastWorkspace();
  const target = workspaces.find((w) => w.id === last) ?? workspaces[0]!;
  return <Navigate to={paths.workspace(target.id)} replace />;
}

/** `/parear?code=…` (link impresso pelo runner) leva ao workspace atual. */
function PairRedirect() {
  const [params] = useSearchParams();
  const workspaces = useSession((s) => s.workspaces);
  const code = params.get("code") ?? params.get("codigo") ?? undefined;
  if (workspaces.length === 0) return <Navigate to={paths.newWorkspace} replace />;
  const last = lastWorkspace();
  const target = workspaces.find((w) => w.id === last) ?? workspaces[0]!;
  return <Navigate to={paths.pair(target.id, code)} replace />;
}

function AgentLinkRedirect() {
  const { ws = "", agentId = "" } = useParams();
  return <Navigate to={`${paths.team(ws)}?agente=${encodeURIComponent(agentId)}`} replace />;
}

/** Links de tarefa do hub (`/w/:ws/tasks/:id`). */
function TaskLinkRedirect() {
  const { ws = "", taskId = "" } = useParams();
  return <Navigate to={paths.tasks(ws, taskId)} replace />;
}

export function App() {
  const load = useSession((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  const p = (el: ReactNode) => <Page>{el}</Page>;
  return (
    <BrowserRouter>
      {isDemo && (
        <div className="pointer-events-none fixed top-0 left-1/2 z-[70] -translate-x-1/2 rounded-b-md bg-agent px-2 py-0.5 text-[11px] font-semibold text-white dark:text-[#1b1e24]">
          Demonstração
        </div>
      )}
      <Routes>
        <Route path={paths.login} element={p(<LoginPage />)} />
        <Route path={paths.signup} element={p(<SignupPage />)} />
        <Route path="/convite/:code" element={p(<InvitePage />)} />
        {/* O hub gera links de convite como /invite/:code. */}
        <Route path="/invite/:code" element={p(<InvitePage />)} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<HomeRedirect />} />
          <Route path={paths.newWorkspace} element={p(<CreateWorkspacePage />)} />
          <Route path="/parear" element={<PairRedirect />} />
          {/* Link impresso pelo runner (`puxibot login`). */}
          <Route path="/runner/parear" element={<PairRedirect />} />
          <Route path="/w/:ws" element={<AppShell />}>
            <Route index element={p(<HomePage />)} />
            <Route path="c/:channelId" element={p(<ChannelPage />)} />
            <Route path="equipe" element={p(<TeamPage />)} />
            <Route path="aprovacoes" element={p(<ApprovalsPage />)} />
            <Route path="tarefas" element={p(<TasksPage />)} />
            <Route path="wiki" element={p(<WikiPage />)} />
            <Route path="wiki/:pageId" element={p(<WikiPage />)} />
            <Route path="drive" element={p(<DrivePage />)} />
            <Route path="rotinas" element={p(<RoutinesPage />)} />
            <Route path="boas-vindas" element={p(<OnboardingPage />)} />
            {/* Aliases dos links de notificação gerados pelo hub. */}
            <Route path="approvals" element={<Navigate to="../aprovacoes" replace />} />
            <Route path="agents/:agentId" element={<AgentLinkRedirect />} />
            <Route path="tasks/:taskId" element={<TaskLinkRedirect />} />
            <Route path="tasks" element={<Navigate to="../tarefas" replace />} />
            <Route path="skills" element={<Navigate to="../config/skills" replace />} />
            <Route path="conectores" element={<Navigate to="../config/conectores" replace />} />
            <Route path="parear" element={p(<PairPage />)} />
            <Route path="config" element={p(<SettingsLayout />)}>
              <Route index element={<Navigate to="perfil" replace />} />
              <Route path="perfil" element={p(<ProfileSettings />)} />
              <Route path="notificacoes" element={p(<NotificationsSettings />)} />
              <Route path="computadores" element={p(<ComputersSettings />)} />
              <Route path="tokens" element={p(<TokensSettings />)} />
              <Route path="workspace" element={p(<WorkspaceSettings />)} />
              <Route path="skills" element={p(<SkillsSettings />)} />
              <Route path="conectores" element={p(<ConnectorsSettings />)} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster />
      <UpdateBanner />
    </BrowserRouter>
  );
}
