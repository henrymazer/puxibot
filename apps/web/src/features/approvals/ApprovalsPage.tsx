import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleCheckBig, Check, X } from "lucide-react";
import type { ApprovalDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { PageHeader } from "../shell/PageHeader";
import { useAgentProfile, useWsId } from "../shell/hooks";
import { AgentAvatar } from "../../components/Avatar";
import { Badge, Button, EmptyState, ErrorState, InlineError, LoadingState, Tabs, Textarea } from "../../components/ui";
import { formatDateTime, formatRelative } from "../../lib/format";
import { actorName, isAdmin } from "../../lib/actors";

type Filter = "pending" | "decided";

const KIND_LABEL: Record<ApprovalDTO["kind"], string> = {
  job_start: "Começar trabalho que ninguém pediu",
  action: "Ação sensível",
};

export function ApprovalsPage() {
  const ws = useWsId();
  const [filter, setFilter] = useState<Filter>("pending");
  const [decided, setDecided] = useState<ApprovalDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pendingMap = useWorkspace((s) => s.approvals);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (filter === "pending") {
        const items = await api.listApprovals(ws, "pending");
        // Sincroniza a lista pendente com o estado (que os eventos mantêm atualizado).
        const dispatch = useWorkspace.getState().dispatch;
        for (const a of items) dispatch({ type: "approval.upserted", approval: a });
      } else {
        const [approved, rejected] = await Promise.all([
          api.listApprovals(ws, "approved"),
          api.listApprovals(ws, "rejected"),
        ]);
        setDecided([...approved, ...rejected].sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt)));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [ws, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(
    () => Object.values(pendingMap).filter((a) => a.status === "pending").sort((a, b) => b.createdAt - a.createdAt),
    [pendingMap],
  );
  const list = filter === "pending" ? pending : decided ?? [];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title="Aprovações"
        icon={<CircleCheckBig className="size-5" />}
        subtitle="Pedidos dos agentes que precisam de uma pessoa"
      />
      <div className="tb-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-6">
          <Tabs<Filter>
            label="Filtrar aprovações"
            value={filter}
            onChange={setFilter}
            tabs={[
              { id: "pending", label: `Pendentes${pending.length ? ` (${pending.length})` : ""}` },
              { id: "decided", label: "Decididas" },
            ]}
            className="mb-4"
          />
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : loading && list.length === 0 ? (
            <LoadingState />
          ) : list.length === 0 ? (
            <EmptyState icon={<CircleCheckBig className="size-5" />} title={filter === "pending" ? "Nada esperando você" : "Nenhuma decisão ainda"}>
              {filter === "pending"
                ? "Quando um agente pedir para fazer algo sensível ou começar um trabalho sozinho, o pedido aparece aqui."
                : "As aprovações decididas aparecem aqui."}
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {list.map((a) => (
                <li key={a.id}>
                  <ApprovalCard
                    approval={a}
                    onDecided={(updated) => {
                      if (filter === "decided") return;
                      setDecided((d) => (d ? [updated, ...d.filter((x) => x.id !== updated.id)] : d));
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalCard({ approval: a, onDecided }: { approval: ApprovalDTO; onDecided: (a: ApprovalDTO) => void }) {
  const ws = useWsId();
  const agents = useWorkspace((s) => s.agents);
  const members = useWorkspace((s) => s.members);
  const me = useWorkspace((s) => s.me);
  const { open } = useAgentProfile();
  const agent = agents[a.agentId];
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDecide = !!me && (a.approverUserId === me.userId || isAdmin(me.role));
  const approverName = actorName({ members, agents }, { type: "user", id: a.approverUserId });

  const decide = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    setError(null);
    try {
      const res = await api.decideApproval(ws, a.id, decision, note.trim() || undefined);
      const updated: ApprovalDTO =
        res && res.id
          ? res
          : { ...a, status: decision, decidedBy: me?.userId ?? null, decidedAt: Date.now(), decisionNote: note.trim() || null };
      useWorkspace.getState().dispatch({ type: "approval.upserted", approval: updated });
      onDecided(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        {agent ? (
          <button type="button" onClick={() => open(agent.id)} aria-label={`Abrir perfil de ${agent.name}`} className="rounded-md">
            <AgentAvatar agent={agent} size="md" />
          </button>
        ) : (
          <span className="size-9 shrink-0 rounded-md bg-surface-2" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{agent?.name ?? "Agente removido"}</span>
            <Badge tone={a.kind === "action" ? "warning" : "agent"}>{KIND_LABEL[a.kind]}</Badge>
            <span className="text-xs text-subtle" title={formatDateTime(a.createdAt)}>
              {formatRelative(a.createdAt)}
            </span>
          </div>
          <h3 className="mt-1 text-base font-medium break-words">{a.title}</h3>
          {a.details && <p className="mt-1 text-sm whitespace-pre-wrap text-muted break-words">{a.details}</p>}
          <p className="mt-2 text-xs text-subtle">Quem decide: {a.approverUserId === me?.userId ? "você" : approverName}</p>
        </div>
      </div>

      {a.status === "pending" ? (
        canDecide ? (
          <div className="mt-3 space-y-2">
            <label className="sr-only" htmlFor={`note-${a.id}`}>
              Nota para o agente (opcional)
            </label>
            <Textarea
              id={`note-${a.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Nota opcional (ex.: pode seguir, mas avise no canal)"
              className="min-h-16"
            />
            <InlineError message={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => void decide("rejected")} loading={busy === "rejected"} disabled={!!busy} icon={<X className="size-4" />}>
                Recusar
              </Button>
              <Button variant="primary" onClick={() => void decide("approved")} loading={busy === "approved"} disabled={!!busy} icon={<Check className="size-4" />}>
                Aprovar
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted">Só {approverName} ou um admin pode decidir.</p>
        )
      ) : (
        <div className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm">
          <Badge tone={a.status === "approved" ? "success" : "danger"}>{a.status === "approved" ? "Aprovado" : "Recusado"}</Badge>
          <span className="ml-2 text-muted">
            {a.decidedBy ? `por ${a.decidedBy === me?.userId ? "você" : actorName({ members, agents }, { type: "user", id: a.decidedBy })}` : ""}
            {a.decidedAt ? ` · ${formatDateTime(a.decidedAt)}` : ""}
          </span>
          {a.decisionNote && <p className="mt-1 text-muted break-words">“{a.decisionNote}”</p>}
        </div>
      )}
    </article>
  );
}
