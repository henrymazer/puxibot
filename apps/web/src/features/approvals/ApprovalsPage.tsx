import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { CircleCheckBig, Check, ExternalLink, KeyRound, X } from "lucide-react";
import type { ApprovalDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { PageHeader } from "../shell/PageHeader";
import { useAgentProfile, useWsId } from "../shell/hooks";
import { AgentAvatar } from "../../components/Avatar";
import { Badge, Button, EmptyState, ErrorState, InlineError, Input, LoadingState, Tabs, Textarea } from "../../components/ui";
import { formatDateTime, formatRelative } from "../../lib/format";
import { actorName, isAdmin } from "../../lib/actors";
import { cn } from "../../lib/cn";

type Filter = "pending" | "decided";

const KIND_LABEL: Record<ApprovalDTO["kind"], string> = {
  job_start: "Começar trabalho que ninguém pediu",
  action: "Ação sensível",
  secret: "Pedido de senha ou token",
};

type Scope = NonNullable<ApprovalDTO["scope"]>;

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: "once", label: "Só esta vez" },
  { value: "job", label: "Neste trabalho" },
  { value: "always", label: "Sempre" },
];

const SCOPE_DECIDED: Record<Scope, string> = {
  once: "Aprovada só uma vez",
  job: "Aprovada para o trabalho",
  always: "Aprovada sempre",
};

/** O que acontece depois do "sim", em uma linha. */
function scopeConsequence(scope: Scope, agentName: string, action: NonNullable<ApprovalDTO["action"]>): string {
  if (scope === "job") return `${agentName} para de pedir para usar ${action.connectorName} até este trabalho terminar.`;
  if (scope === "always")
    return `Cria uma regra permanente: ${agentName} passa a usar “${action.tool}” em ${action.connectorName} sem pedir de novo.`;
  return `Vale só para esta ação. Na próxima, ${agentName} pede de novo.`;
}

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
                  {a.kind === "secret" ? <SecretRequestCard approval={a} /> : null}
                  {a.kind !== "secret" && <ApprovalCard
                    approval={a}
                    onDecided={(updated) => {
                      if (filter === "decided") return;
                      setDecided((d) => (d ? [updated, ...d.filter((x) => x.id !== updated.id)] : d));
                    }}
                  />}
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
  const [scope, setScope] = useState<Scope>("once");
  const scopeId = useId();
  // Aprovação de uma ação específica num serviço conectado ou no navegador.
  const action = a.actionId ? a.action ?? null : null;
  const isActionApproval = !!a.actionId;
  const agentName = agent?.name ?? "O agente";
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDecide = !!me && (a.approverUserId === me.userId || isAdmin(me.role));
  const approverName = actorName({ members, agents }, { type: "user", id: a.approverUserId });

  const decide = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    setError(null);
    try {
      const chosen = isActionApproval && decision === "approved" ? scope : undefined;
      const res = await api.decideApproval(ws, a.id, decision, note.trim() || undefined, chosen);
      const updated: ApprovalDTO =
        res && res.id
          ? res
          : { ...a, status: decision, decidedBy: me?.userId ?? null, decidedAt: Date.now(), decisionNote: note.trim() || null, ...(chosen ? { scope: chosen } : {}) };
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
          {action && (
            <dl className="mt-2 space-y-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted">Serviço:</dt>
                <dd className="min-w-0 font-medium break-words">{action.connectorName}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted">Ferramenta:</dt>
                <dd className="min-w-0 font-mono text-xs leading-5 break-all">{action.tool}</dd>
              </div>
              {action.summary && (
                <div>
                  <dt className="text-muted">O que vai ser enviado:</dt>
                  <dd className="mt-0.5 font-mono text-xs break-all whitespace-pre-wrap">{action.summary}</dd>
                </div>
              )}
            </dl>
          )}
          {/* Em aprovação de ação, os detalhes são os próprios argumentos, já mostrados no quadro acima. */}
          {a.details && a.details !== a.action?.summary && <p className="mt-1 text-sm whitespace-pre-wrap text-muted break-words">{a.details}</p>}
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
            {isActionApproval && (
              <div>
                <p id={`${scopeId}-label`} className="text-sm font-medium">
                  Se aprovar, vale para:
                </p>
                <div
                  role="radiogroup"
                  aria-labelledby={`${scopeId}-label`}
                  aria-describedby={`${scopeId}-hint`}
                  className="mt-1.5 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center"
                >
                  {SCOPE_OPTIONS.map((o) => {
                    const checked = scope === o.value;
                    const quiet = o.value === "always";
                    return (
                      <label
                        key={o.value}
                        className={cn(
                          "flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary",
                          quiet
                            ? cn("border-transparent sm:ml-auto", checked ? "bg-surface-2 text-ink" : "text-muted hover:text-ink")
                            : checked
                              ? "border-primary bg-primary-soft font-medium text-primary-text"
                              : "border-line-strong bg-surface hover:bg-surface-2",
                          busy && "cursor-default opacity-55",
                        )}
                      >
                        <input
                          type="radio"
                          name={`${scopeId}-scope`}
                          value={o.value}
                          checked={checked}
                          disabled={!!busy}
                          onChange={() => setScope(o.value)}
                          className="size-4 shrink-0 accent-[var(--tb-primary)]"
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
                <p id={`${scopeId}-hint`} aria-live="polite" className={cn("mt-1.5 text-xs break-words", scope === "always" ? "text-warning" : "text-muted")}>
                  {scopeConsequence(scope, agentName, action ?? { connectorName: "este serviço", tool: "esta ferramenta", summary: "" })}
                </p>
              </div>
            )}
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
          <Badge tone={a.status === "approved" ? "success" : "danger"}>
            {a.status === "approved" ? (isActionApproval && a.scope ? SCOPE_DECIDED[a.scope] : "Aprovado") : "Recusado"}
          </Badge>
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

/**
 * Pedido de segredo: a pessoa digita aqui e o valor vai direto para o hub, que o guarda cifrado no destino.
 * O agente só fica sabendo que foi guardado. O campo é limpo logo depois do envio e nada fica no estado global.
 */
function SecretRequestCard({ approval: a }: { approval: ApprovalDTO }) {
  const ws = useWsId();
  const agents = useWorkspace((s) => s.agents);
  const members = useWorkspace((s) => s.members);
  const me = useWorkspace((s) => s.me);
  const agent = agents[a.agentId];
  const agentName = agent?.name ?? "O agente";
  const target = a.secret ?? null;
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState(target?.target === "vault" ? target.username ?? "" : "");
  const [busy, setBusy] = useState<"save" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const mine = !!me && a.approverUserId === me.userId;
  const approverName = actorName({ members, agents }, { type: "user", id: a.approverUserId });
  const needsUser = target?.target === "vault";

  const answer = async (save: boolean) => {
    setBusy(save ? "save" : "decline");
    setError(null);
    try {
      const res = await api.answerSecretRequest(ws, a.id, save ? { secret, ...(needsUser ? { username: username.trim() } : {}) } : null);
      setSecret("");
      const updated: ApprovalDTO = res && res.id ? res : { ...a, status: save ? "approved" : "rejected", decidedBy: me?.userId ?? null, decidedAt: Date.now() };
      useWorkspace.getState().dispatch({ type: "approval.upserted", approval: updated });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        {agent ? <AgentAvatar agent={agent} size="md" /> : <span className="size-9 shrink-0 rounded-md bg-surface-2" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{agent?.name ?? "Agente removido"}</span>
            <Badge tone="warning">{KIND_LABEL.secret}</Badge>
            <span className="text-xs text-subtle" title={formatDateTime(a.createdAt)}>
              {formatRelative(a.createdAt)}
            </span>
          </div>
          <h3 className="mt-1 flex items-center gap-1.5 text-base font-medium break-words">
            <KeyRound className="size-4 shrink-0 text-muted" aria-hidden />
            {a.title}
          </h3>
          {a.details && <p className="mt-1 text-sm whitespace-pre-wrap text-muted break-words">{a.details}</p>}
          {target && (
            <dl className="mt-2 space-y-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted">Onde fica guardado:</dt>
                <dd className="min-w-0 font-medium break-words">
                  {target.target === "vault" ? `No seu cofre, como “${target.name}”` : `No conector ${target.name}`}
                </dd>
              </div>
              {target.target === "vault" && (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted">Só será digitado em:</dt>
                  <dd className="min-w-0 font-mono text-xs leading-5 break-all">{target.origin}</dd>
                </div>
              )}
            </dl>
          )}
          {target?.target === "vault" && a.status === "pending" && (
            <p className="mt-2 text-xs text-warning">Confira o endereço acima: a senha vale para esse site. Se não for o site certo, recuse.</p>
          )}
        </div>
      </div>

      {a.status === "pending" ? (
        mine ? (
          <form
            className="mt-3 space-y-2"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              if (secret && (!needsUser || username.trim())) void answer(true);
            }}
          >
            {needsUser && (
              <div>
                <label htmlFor={`${fieldId}-user`} className="text-sm font-medium">
                  Usuário ou e-mail
                </label>
                <Input id={`${fieldId}-user`} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" disabled={!!busy} className="mt-1" />
              </div>
            )}
            <div>
              <label htmlFor={`${fieldId}-secret`} className="text-sm font-medium">
                {needsUser ? "Senha" : "Token ou chave"}
              </label>
              <Input
                id={`${fieldId}-secret`}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                disabled={!!busy}
                className="mt-1 font-mono"
              />
              <p className="mt-1 text-xs text-muted">
                O valor vai direto para o Puxibot e fica cifrado. {agentName} não vê o que você digitou, e ele não aparece na conversa.
              </p>
            </div>
            {target?.url && (
              <a href={target.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm text-primary-text underline">
                Onde consigo isso <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
            <InlineError message={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" onClick={() => void answer(false)} loading={busy === "decline"} disabled={!!busy} icon={<X className="size-4" />}>
                Não informar
              </Button>
              <Button type="submit" variant="primary" loading={busy === "save"} disabled={!!busy || !secret || (needsUser && !username.trim())} icon={<Check className="size-4" />}>
                Guardar
              </Button>
            </div>
          </form>
        ) : (
          <p className="mt-3 text-xs text-muted">Só {approverName} pode responder: o valor fica guardado na conta dessa pessoa.</p>
        )
      ) : (
        <div className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm">
          <Badge tone={a.status === "approved" ? "success" : "danger"}>{a.status === "approved" ? "Guardado" : "Não informado"}</Badge>
          <span className="ml-2 text-muted">{a.decidedAt ? formatDateTime(a.decidedAt) : ""}</span>
        </div>
      )}
    </article>
  );
}
