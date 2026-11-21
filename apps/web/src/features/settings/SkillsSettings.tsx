import { useEffect, useState } from "react";
import { Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import type { SkillDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, InlineError, Input, LoadingState, LockedNote, Modal, SectionTitle, Textarea } from "../../components/ui";
import { toast } from "../../components/toast";
import { Segmented } from "../agents/shared";
import { Markdown } from "../chat/Markdown";
import { isAdmin } from "../../lib/actors";
import { formatRelative } from "../../lib/format";
import { useWsId } from "../shell/hooks";

export function SkillsSettings() {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const [items, setItems] = useState<SkillDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillDTO | "new" | null>(null);
  const [deleting, setDeleting] = useState<SkillDTO | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    api
      .listSkills(ws)
      .then((l) => setItems(l.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = (s: SkillDTO) => isAdmin(me?.role) || !s.createdBy || s.createdBy === me?.userId;
  const usedBy = (id: string) => Object.values(agents).filter((a) => a.skillIds.includes(id));

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteSkill(ws, deleting.id);
      setItems((l) => l?.filter((x) => x.id !== deleting.id) ?? null);
      // Os agentes deixam de usar a skill apagada.
      for (const a of usedBy(deleting.id)) useWorkspace.getState().upsertAgent({ ...a, skillIds: a.skillIds.filter((x) => x !== deleting.id) });
      toast.success("Skill apagada.");
      setDeleting(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <SectionTitle
          action={
            <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              Nova skill
            </Button>
          }
        >
          Skills
        </SectionTitle>
        <p className="mb-4 text-sm text-muted">
          Instruções reutilizáveis, como “como revisar um PR” ou “tom de voz da marca”. Ligue cada skill aos agentes que devem usá-la, na aba
          “Ferramentas e acesso” do perfil do agente.
        </p>
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : items === null ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState icon={<Sparkles className="size-5" />} title="Nenhuma skill ainda">
            Crie a primeira e ligue aos agentes.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((s) => {
              const users = usedBy(s.id);
              const author = s.createdBy ? members[s.createdBy]?.name : null;
              return (
                <li key={s.id} className="flex items-start gap-3 px-3 py-3 md:px-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-agent-soft text-agent">
                    <Sparkles className="size-4.5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{s.name}</p>
                    {s.description && <p className="text-sm text-muted">{s.description}</p>}
                    <p className="mt-0.5 text-xs text-subtle">
                      {users.length === 0 ? "Nenhum agente usa" : `Usada por ${users.map((a) => a.name).join(", ")}`}
                      {" · "}atualizada {formatRelative(s.updatedAt)}
                      {author && ` · criada por ${author}`}
                    </p>
                  </div>
                  <IconButton label={canEdit(s) ? `Editar ${s.name}` : `Ver ${s.name}`} onClick={() => setEditing(s)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  {canEdit(s) && (
                    <IconButton label={`Apagar ${s.name}`} onClick={() => setDeleting(s)} className="hover:text-danger">
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {editing && (
        <SkillDialog
          skill={editing === "new" ? undefined : editing}
          readOnly={editing !== "new" && !canEdit(editing)}
          onClose={() => setEditing(null)}
          onSaved={(s) => setItems((l) => (l ? (l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]) : [s]))}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        loading={busy}
        danger
        title={`Apagar "${deleting?.name}"?`}
        body={
          deleting && usedBy(deleting.id).length
            ? `${usedBy(deleting.id)
                .map((a) => a.name)
                .join(", ")} deixa${usedBy(deleting.id).length > 1 ? "m" : ""} de usar esta skill.`
            : "Nenhum agente usa esta skill."
        }
        confirmLabel="Apagar"
      />
    </>
  );
}

function SkillDialog({ skill, readOnly, onClose, onSaved }: { skill?: SkillDTO; readOnly?: boolean; onClose: () => void; onSaved: (s: SkillDTO) => void }) {
  const ws = useWsId();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const [mode, setMode] = useState<"editar" | "ver">(readOnly ? "ver" : "editar");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return setError("Dê um nome à skill.");
    if (!body.trim()) return setError("Escreva as instruções da skill.");
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), description: description.trim(), body };
      const saved = skill ? await api.updateSkill(ws, skill.id, input) : await api.createSkill(ws, input);
      onSaved(saved && saved.id ? saved : { ...(skill as SkillDTO), ...input, updatedAt: Date.now() });
      toast.success(skill ? "Skill salva." : "Skill criada.");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={readOnly ? skill!.name : skill ? "Editar skill" : "Nova skill"}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Fechar</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              {skill ? "Salvar" : "Criar skill"}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {readOnly && <LockedNote>Só quem criou ou um admin muda esta skill.</LockedNote>}
        <Field label="Nome">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={readOnly} data-autofocus placeholder="Ex.: Revisar pull request" />}</Field>
        <Field label="Para que serve" hint="Uma frase. O agente lê isso para saber quando usar.">
          {(id, d) => <Input id={id} aria-describedby={d} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={readOnly} />}
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium" id="skill-body-label">
              Instruções
            </span>
            {!readOnly && (
              <Segmented
                label="Modo"
                value={mode}
                onChange={setMode}
                options={[
                  { id: "editar", label: "Escrever" },
                  { id: "ver", label: "Visualizar" },
                ]}
              />
            )}
          </div>
          {mode === "editar" ? (
            <Textarea aria-labelledby="skill-body-label" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-64 font-mono text-sm" maxLength={50_000} placeholder={"1. Leia a descrição do PR.\n2. Rode os testes.\n3. …"} />
          ) : (
            <div className="min-h-32 rounded-md border border-line bg-surface p-3 text-sm">{body ? <Markdown text={body} /> : <span className="text-subtle">Sem instruções.</span>}</div>
          )}
        </div>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
