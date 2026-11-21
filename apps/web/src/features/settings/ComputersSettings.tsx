import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, Laptop, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import type { RunnerDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { useWsId } from "../shell/hooks";
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, InlineError, SectionTitle } from "../../components/ui";
import { PersonAvatar } from "../../components/Avatar";
import { toast } from "../../components/toast";
import { CLI_LABEL, isAdmin } from "../../lib/actors";
import { formatRelative } from "../../lib/format";
import { InstallRunnerSteps } from "./InstallRunner";
import { PairForm } from "./PairForm";

const PLATFORM: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

const ISOLATION: Record<string, { label: string; text: string; warn?: boolean }> = {
  sandbox: { label: "Sandbox do sistema", text: "O agente só alcança a própria pasta de trabalho e as pastas que você liberar. A rede continua liberada." },
  container: { label: "Container", text: "Cada execução roda num container limpo, que para ao terminar. Isolamento mais forte." },
  none: { label: "Sem isolamento", text: "O agente tem acesso ao computador como a pessoa logada. Use só se souber o que está fazendo.", warn: true },
};

export function ComputersSettings() {
  const ws = useWsId();
  const runnersMap = useWorkspace((s) => s.runners);
  const myUserId = useWorkspace((s) => s.myUserId);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const runners = await api.listRunners(ws);
      useWorkspace.setState({ runners: Object.fromEntries(runners.map((r) => [r.id, r])) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const { mine, team } = useMemo(() => {
    const list = Object.values(runnersMap).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return { mine: list.filter((r) => r.userId === myUserId), team: list.filter((r) => r.userId !== myUserId) };
  }, [runnersMap, myUserId]);

  return (
    <>
      <Card>
        <SectionTitle
          action={
            <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={refreshing} icon={<RefreshCw className="size-4" />}>
              Atualizar
            </Button>
          }
        >
          Seus computadores
        </SectionTitle>
        <InlineError message={error} />
        {mine.length === 0 ? (
          <EmptyState icon={<Laptop className="size-5" />} title="Nenhum computador pareado">
            Instale o runner no seu computador (instruções abaixo) para os agentes trabalharem com a sua assinatura.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {mine.map((r) => (
              <RunnerItem key={r.id} runner={r} />
            ))}
          </ul>
        )}
      </Card>

      <InstallCard />

      <Card>
        <SectionTitle>Parear um computador</SectionTitle>
        <p className="mb-3 text-sm text-muted">Rodou os comandos acima? Digite aqui o código que apareceu no terminal.</p>
        <PairForm />
      </Card>

      <Card>
        <SectionTitle>Do time</SectionTitle>
        {team.length === 0 ? (
          <p className="text-sm text-muted">Ninguém mais do time pareou um computador ainda.</p>
        ) : (
          <ul className="space-y-3">
            {team.map((r) => (
              <RunnerItem key={r.id} runner={r} showOwner />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function RunnerItem({ runner: r, showOwner }: { runner: RunnerDTO; showOwner?: boolean }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const owner = useWorkspace((s) => s.members[r.userId]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const canRemove = !!me && (me.userId === r.userId || isAdmin(me.role));
  const iso = r.isolation ? ISOLATION[r.isolation] : undefined;

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteRunner(ws, r.id);
      useWorkspace.setState((s) => {
        const { [r.id]: _gone, ...runners } = s.runners;
        return { runners };
      });
      toast.success(`${r.name} foi removido.`);
      setConfirm(false);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-line p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
          <Laptop className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-all">{r.name}</span>
            {r.online ? <Badge tone="success">Ligado</Badge> : <Badge>Desligado</Badge>}
            {r.platform && <span className="text-xs text-subtle">{PLATFORM[r.platform] ?? r.platform}</span>}
          </div>
          {showOwner && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <PersonAvatar member={owner} name={owner?.name ?? "?"} size="xs" />
              {owner?.name ?? "Pessoa removida"}
            </div>
          )}
          {!r.online && r.lastSeenAt && <p className="mt-0.5 text-xs text-subtle">Visto por último {formatRelative(r.lastSeenAt)}</p>}
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="CLIs detectadas">
            {r.clis.length === 0 && <li className="text-xs text-muted">Nenhuma CLI de IA encontrada.</li>}
            {r.clis.map((c) => (
              <li key={c.cli} className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs">
                {c.loggedIn ? (
                  <CheckCircle2 className="size-3.5 text-success" aria-label="Logada" />
                ) : (
                  <CircleDashed className="size-3.5 text-warning" aria-label={c.loggedIn === false ? "Não logada" : "Login desconhecido"} />
                )}
                {CLI_LABEL[c.cli] ?? c.cli}
                {c.version && <span className="text-subtle">{c.version}</span>}
                {c.loggedIn === false && <span className="text-warning">sem login</span>}
              </li>
            ))}
          </ul>
          {iso && (
            <p className={iso.warn ? "mt-2 flex items-start gap-1.5 text-xs text-warning" : "mt-2 flex items-start gap-1.5 text-xs text-muted"}>
              {iso.warn ? <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden /> : <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />}
              <span>
                <strong className="font-medium">{iso.label}.</strong> {iso.text}
              </span>
            </p>
          )}
        </div>
        {canRemove && (
          <IconButton label={`Remover ${r.name}`} onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void remove()}
        loading={busy}
        danger
        title="Remover computador?"
        confirmLabel="Remover"
        body={`${r.name} para de receber trabalhos. Para usar de novo, será preciso parear outra vez.`}
      />
    </li>
  );
}

function InstallCard() {
  return (
    <Card>
      <SectionTitle>Instalar o runner</SectionTitle>
      <p className="mb-4 text-sm text-muted">
        O runner é o programa que executa os agentes no seu computador, usando a CLI de IA que você já tem instalada e logada.
      </p>
      <InstallRunnerSteps />
      <div className="mt-5 space-y-2 rounded-md bg-surface-2 p-3 text-sm text-muted">
        <p>
          <strong className="font-medium text-ink">Onde o trabalho roda:</strong> no computador de quem pede, se estiver ligado. Se não estiver, no
          computador do responsável pelo agente.
        </p>
        <p>
          <strong className="font-medium text-ink">Quem paga:</strong> quando o trabalho cai no computador do responsável, é a assinatura dele que
          atende o pedido de outra pessoa. Cada resposta mostra de quem era o computador.
        </p>
      </div>
    </Card>
  );
}
