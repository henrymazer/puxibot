import { useCallback, useEffect, useState } from "react";
import { Brain, Pencil, Plus, Trash2 } from "lucide-react";
import type { AgentDTO, MemoryDTO } from "@puxibot/shared";
import { api, ApiClientError, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { actorName, canEditAgent } from "../../lib/actors";
import { formatRelative } from "../../lib/format";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, IconButton, InlineError, LoadingState, LockedNote, Textarea } from "../../components/ui";
import { toast } from "../../components/toast";
import { useWsId } from "../shell/hooks";

const SOURCE_LABEL: Record<MemoryDTO["source"], string> = {
  agent: "anotada pelo agente",
  user: "adicionada por pessoa",
  extraction: "extraída de conversa",
};

export function MemoryTab({ agent }: { agent: AgentDTO }) {
  const me = useWorkspace((s) => s.me);
  return (
    <div className="flex flex-col gap-6">
      <MemoryList
        agentId={agent.id}
        title={`Memória de ${agent.name}`}
        description="O que só este agente lembra entre uma conversa e outra."
        canEdit={canEditAgent(agent, me)}
        lockedReason="Só o responsável ou um admin muda a memória deste agente."
      />
      <MemoryList
        agentId={null}
        title="Memória do time"
        description="Vale para todos os agentes do workspace."
        canEdit={!!me}
        lockedReason=""
      />
    </div>
  );
}

function MemoryList({
  agentId,
  title,
  description,
  canEdit,
  lockedReason,
}: {
  agentId: string | null;
  title: string;
  description: string;
  canEdit: boolean;
  lockedReason: string;
}) {
  const ws = useWsId();
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const [items, setItems] = useState<MemoryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<MemoryDTO | null>(null);

  const load = useCallback(() => {
    setError(null);
    setItems(null);
    api
      .listMemories(ws, agentId)
      .then((list) => setItems(list.sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((e) => {
        if (e instanceof ApiClientError && (e.status === 404 || e.status === 501)) setUnavailable(true);
        else setError(errorMessage(e));
      });
  }, [ws, agentId]);
  useEffect(load, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const add = () =>
    run("add", async () => {
      const m = await api.createMemory(ws, agentId, draft.trim());
      setItems((l) => [m, ...(l ?? [])]);
      setDraft("");
      setAdding(false);
    });

  const saveEdit = (m: MemoryDTO) =>
    run(m.id, async () => {
      const updated = await api.updateMemory(ws, agentId, m.id, editDraft.trim());
      const next = updated && updated.id ? updated : { ...m, content: editDraft.trim(), updatedAt: Date.now() };
      setItems((l) => (l ?? []).map((x) => (x.id === m.id ? next : x)));
      setEditing(null);
    });

  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted">{description}</p>
        </div>
        {!unavailable && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={!canEdit || adding}>
            Adicionar
          </Button>
        )}
      </div>
      {!canEdit && lockedReason && <LockedNote>{lockedReason}</LockedNote>}

      {adding && (
        <form
          className="mb-3 flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void add();
          }}
        >
          <label htmlFor={`mem-new-${agentId ?? "team"}`} className="text-sm font-medium">
            O que deve ser lembrado
          </label>
          <Textarea id={`mem-new-${agentId ?? "team"}`} value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-20" data-autofocus autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => { setAdding(false); setDraft(""); }}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()} loading={busy === "add"}>
              Salvar
            </Button>
          </div>
        </form>
      )}
      <InlineError message={actionError} />

      {unavailable ? (
        <EmptyState icon={<Brain className="size-5" />} title="A memória ainda não está disponível neste hub">
          Atualize o hub para ver e editar o que os agentes lembram.
        </EmptyState>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : items === null ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-muted">Nada guardado ainda.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {items.map((m) => (
            <li key={m.id} className="flex gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                {editing === m.id ? (
                  <div className="flex flex-col gap-2">
                    <label htmlFor={`mem-${m.id}`} className="sr-only">
                      Editar memória
                    </label>
                    <Textarea id={`mem-${m.id}`} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} className="min-h-20" autoFocus />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setEditing(null)}>
                        Cancelar
                      </Button>
                      <Button size="sm" variant="primary" disabled={!editDraft.trim()} loading={busy === m.id} onClick={() => void saveEdit(m)}>
                        Salvar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                      <Badge tone={m.source === "user" ? "neutral" : "agent"}>{SOURCE_LABEL[m.source]}</Badge>
                      {actorName({ members, agents }, m.createdBy)} · {formatRelative(m.updatedAt)}
                    </p>
                  </>
                )}
              </div>
              {editing !== m.id && (
                <div className="flex shrink-0 items-start">
                  <IconButton
                    size="sm"
                    label="Editar memória"
                    disabled={!canEdit}
                    onClick={() => {
                      setEditing(m.id);
                      setEditDraft(m.content);
                    }}
                  >
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton size="sm" label="Apagar memória" disabled={!canEdit} onClick={() => setConfirm(m)} className="hover:text-danger">
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Apagar memória?"
        body={<>O agente deixa de lembrar disto: “{confirm?.content.slice(0, 120)}”.</>}
        confirmLabel="Apagar"
        danger
        loading={!!confirm && busy === confirm.id}
        onConfirm={() => {
          const m = confirm!;
          void run(m.id, async () => {
            await api.deleteMemory(ws, agentId, m.id);
            setItems((l) => (l ?? []).filter((x) => x.id !== m.id));
            setConfirm(null);
            toast.success("Memória apagada.");
          });
        }}
      />
    </section>
  );
}
