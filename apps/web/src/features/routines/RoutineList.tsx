import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, Hash, MessageSquare, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { RoutineDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { AgentAvatar } from "../../components/Avatar";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, IconButton, LoadingState, Toggle } from "../../components/ui";
import { toast } from "../../components/toast";
import { canEditAgent, channelLabel } from "../../lib/actors";
import { describeCron } from "../../lib/cron";
import { formatDateTime, formatRelative } from "../../lib/format";
import { paths } from "../../lib/paths";
import { useAgentProfile } from "../shell/hooks";
import { RoutineDialog } from "./RoutineDialog";

export function useRoutines(agentId?: string) {
  const ws = useWorkspace((s) => s.wsId)!;
  const [items, setItems] = useState<RoutineDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api
      .listRoutines(ws, { agentId })
      .then((l) => setItems(agentId ? l.filter((r) => r.agentId === agentId) : l))
      .catch((e) => setError(errorMessage(e)));
  }, [ws, agentId]);
  useEffect(load, [load]);
  const upsert = (r: RoutineDTO) => setItems((l) => (l ? (l.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? r : x)) : [...l, r]) : [r]));
  const remove = (id: string) => setItems((l) => l?.filter((x) => x.id !== id) ?? null);
  return { items, error, load, upsert, remove };
}

function future(ms: number | null): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff < 60_000) return "em instantes";
  if (diff < 3600_000) return `em ${Math.round(diff / 60_000)} min`;
  if (diff < 86400_000) return `em ${Math.round(diff / 3600_000)} h`;
  return formatDateTime(ms);
}

const RUN_SKIPPED: Record<string, string> = {
  agent_paused: "O agente está pausado; a rotina não rodou.",
  budget: "O orçamento do mês do agente acabou; a rotina não rodou.",
  no_channel: "A rotina não tem uma conversa onde publicar.",
  agent_missing: "O agente desta rotina não existe mais.",
};

export function RoutineList({ agentId, showAgent }: { agentId?: string; showAgent?: boolean }) {
  const { items, error, load, upsert, remove } = useRoutines(agentId);
  const agents = useWorkspace((s) => s.agents);
  const me = useWorkspace((s) => s.me);
  const [editing, setEditing] = useState<RoutineDTO | "new" | null>(null);
  const agent = agentId ? agents[agentId] : undefined;
  const canCreate = agent ? canEditAgent(agent, me) : Object.values(agents).some((a) => canEditAgent(a, me));

  const list = (items ?? []).slice().sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted">
          {agent ? `Trabalhos que ${agent.name} faz sozinho, no horário marcado.` : "Trabalhos que os agentes fazem sozinhos, no horário marcado."} Rodam no computador do responsável pelo agente.
        </p>
        {canCreate && (
          <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            Nova rotina
          </Button>
        )}
      </div>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : items === null ? (
        <LoadingState />
      ) : list.length === 0 ? (
        <EmptyState icon={<CalendarClock className="size-5" />} title="Nenhuma rotina ainda">
          Ex.: um resumo dos PRs todo dia útil às 9h, ou conferir pagamentos a cada 6 horas.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {list.map((r) => (
            <RoutineRow key={r.id} routine={r} showAgent={showAgent} onEdit={() => setEditing(r)} onChanged={upsert} onRemoved={() => remove(r.id)} />
          ))}
        </ul>
      )}
      {editing && (
        <RoutineDialog routine={editing === "new" ? undefined : editing} agentId={agentId} onClose={() => setEditing(null)} onSaved={upsert} />
      )}
    </div>
  );
}

function RoutineRow({
  routine: r,
  showAgent,
  onEdit,
  onChanged,
  onRemoved,
}: {
  routine: RoutineDTO;
  showAgent?: boolean;
  onEdit: () => void;
  onChanged: (r: RoutineDTO) => void;
  onRemoved: () => void;
}) {
  const ws = useWorkspace((s) => s.wsId)!;
  const agent = useWorkspace((s) => s.agents[r.agentId]);
  const channel = useWorkspace((s) => (r.channelId ? s.channels[r.channelId] : undefined));
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  const me = useWorkspace((s) => s.me);
  const profile = useAgentProfile();
  const [running, setRunning] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canEdit = agent ? canEditAgent(agent, me) : false;

  const run = async () => {
    setRunning(true);
    try {
      const res = await api.runRoutine(ws, r.id);
      const who = agent?.name ?? "O agente";
      if (res.skipped) {
        toast.error(RUN_SKIPPED[res.skipped] ?? `"${r.name}" não rodou (${res.skipped}).`);
      } else {
        toast.success(r.kind === "daily_summary" ? `Resumo publicado${channel ? ` em ${channel.kind === "dm" ? "conversa direta" : `#${channel.name}`}` : ""}.` : `${who} começou "${r.name}".`);
        onChanged({ ...r, lastRunAt: Date.now() });
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setRunning(false);
    }
  };
  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      const saved = await api.updateRoutine(ws, r.id, { enabled });
      onChanged(saved && saved.id ? saved : { ...r, enabled });
    } catch (e) {
      toast.error(e);
    } finally {
      setToggling(false);
    }
  };
  const del = async () => {
    setDeleting(true);
    try {
      await api.deleteRoutine(ws, r.id);
      onRemoved();
      toast.success("Rotina apagada.");
    } catch (e) {
      toast.error(e);
      setDeleting(false);
      setConfirm(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 px-3 py-3 md:flex-row md:items-center md:px-4">
      <div className="flex min-w-0 flex-1 gap-3">
        {showAgent && agent && (
          <button type="button" onClick={() => profile.open(agent.id, "rotinas")} aria-label={`Perfil de ${agent.name}`} className="shrink-0 self-start rounded-md">
            <AgentAvatar agent={agent} size="md" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium break-words">{r.name}</span>
            {r.kind === "daily_summary" && <Badge tone="agent">Resumo diário</Badge>}
            {!r.enabled && <Badge>Desligada</Badge>}
          </div>
          <p className="text-sm text-muted">
            {showAgent && agent && <span>{agent.name} · </span>}
            {describeCron(r.cron)}
            <span className="text-subtle"> ({r.timezone.replace(/_/g, " ")})</span>
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-subtle">
            {channel ? (
              <Link to={paths.channel(ws, channel.id)} className="inline-flex items-center gap-0.5 hover:underline">
                {channel.kind === "dm" ? <MessageSquare className="size-3" aria-hidden /> : <Hash className="size-3" aria-hidden />}
                {channel.kind === "dm" ? channelLabel({ members, agents, myUserId }, channel) : channel.name}
              </Link>
            ) : (
              <span>Sem canal</span>
            )}
            <span title={r.nextRunAt ? formatDateTime(r.nextRunAt) : undefined}>Próxima: {r.enabled ? future(r.nextRunAt) : "desligada"}</span>
            <span title={r.lastRunAt ? formatDateTime(r.lastRunAt) : undefined}>Última: {r.lastRunAt ? formatRelative(r.lastRunAt) : "nunca"}</span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 max-md:justify-between">
        <span className="mr-2">
          <Toggle checked={r.enabled} onChange={(v) => void toggle(v)} label="Ligada" disabled={!canEdit || toggling} />
        </span>
        <Button size="sm" icon={<Play className="size-4" />} loading={running} onClick={() => void run()} disabled={!canEdit}>
          Executar agora
        </Button>
        <IconButton label={`Editar ${r.name}`} onClick={onEdit} disabled={!canEdit}>
          <Pencil className="size-4" />
        </IconButton>
        {r.kind !== "daily_summary" && (
          <IconButton label={`Apagar ${r.name}`} onClick={() => setConfirm(true)} disabled={!canEdit} className="hover:text-danger">
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void del()}
        loading={deleting}
        danger
        title={`Apagar "${r.name}"?`}
        body="O agente para de fazer esse trabalho sozinho. O que ele já fez continua no histórico."
        confirmLabel="Apagar"
      />
    </li>
  );
}
