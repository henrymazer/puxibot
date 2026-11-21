import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MailX } from "lucide-react";
import { api, errorMessage } from "../../api";
import { useSession } from "../../store/session";
import { Button, EmptyState, ErrorState, InlineError, LoadingState } from "../../components/ui";
import { paths } from "../../lib/paths";
import { AuthLayout } from "./AuthLayout";

export function InvitePage() {
  const { code = "" } = useParams();
  const status = useSession((s) => s.status);
  const user = useSession((s) => s.user);
  const addWorkspace = useSession((s) => s.addWorkspace);
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ workspaceName: string; valid: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadError(null);
    api.getInvite(code).then(setInfo).catch((e) => setLoadError(errorMessage(e)));
  };
  useEffect(load, [code]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const ws = await api.acceptInvite(code);
      addWorkspace(ws);
      navigate(paths.workspace(ws.id), { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <AuthLayout title="Convite"><ErrorState message={loadError} onRetry={load} /></AuthLayout>;
  if (!info || status === "loading") return <AuthLayout title="Convite"><LoadingState /></AuthLayout>;
  if (!info.valid) {
    return (
      <AuthLayout title="Convite">
        <EmptyState icon={<MailX className="size-5" />} title="Este convite não vale mais">
          Ele pode ter expirado ou já ter sido usado. Peça um novo link para quem convidou você.
        </EmptyState>
      </AuthLayout>
    );
  }
  const back = encodeURIComponent(paths.invite(code));
  return (
    <AuthLayout title={`Entrar em ${info.workspaceName}`} subtitle="Você foi convidado para trabalhar com esse time e os agentes dele.">
      {status === "authed" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Você vai entrar como <strong className="text-ink">{user?.name}</strong> ({user?.email}).
          </p>
          <InlineError message={error} />
          <Button variant="primary" size="lg" onClick={accept} loading={busy}>
            Aceitar convite
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Link to={`${paths.signup}?convite=${encodeURIComponent(code)}&next=${back}`} className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-5 font-medium text-primary-fg hover:bg-primary-hover">
            Criar conta e entrar
          </Link>
          <Link to={`${paths.login}?next=${back}`} className="inline-flex h-12 items-center justify-center rounded-md border border-line-strong bg-surface px-5 font-medium hover:bg-surface-2">
            Já tenho conta
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}
