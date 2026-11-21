import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TASK_STATUSES, type ActorRef, type TaskDTO, type TaskStatus } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { errorMessage } from "../../api";
import { Button, Field, InlineError, Input, Modal, Select, Textarea } from "../../components/ui";
import { toast } from "../../components/toast";
import { paths } from "../../lib/paths";
import { distinctLabels, distinctProjects, PRIORITY_LABEL, STATUS_LABEL } from "../../lib/kanban";
import { AssigneeButton } from "./TaskBits";
import { createTask, useNewTask, type NewTaskPrefill } from "./actions";
import { LabelsInput } from "./LabelsInput";

/** Montado pelo AppShell: abre "Nova tarefa" de qualquer tela (ex.: pela mensagem do chat). */
export function NewTaskHost() {
  const prefill = useNewTask((s) => s.prefill);
  const close = useNewTask((s) => s.close);
  if (!prefill) return null;
  return <NewTaskDialog prefill={prefill} onClose={close} />;
}

export function NewTaskDialog({ prefill, onClose, onCreated }: { prefill: NewTaskPrefill; onClose: () => void; onCreated?: (t: TaskDTO) => void }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const tasks = useWorkspace((s) => s.tasks);
  const navigate = useNavigate();
  const [title, setTitle] = useState(prefill.title ?? "");
  const [description, setDescription] = useState(prefill.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(prefill.status ?? "todo");
  const [priority, setPriority] = useState<TaskDTO["priority"]>("medium");
  const [assignee, setAssignee] = useState<ActorRef | null>(null);
  const [project, setProject] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = Object.values(tasks);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) {
      setError("Dê um título à tarefa.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await createTask({
        title: title.trim(),
        description,
        status,
        priority,
        labels,
        project: project.trim() || undefined,
        assignee,
        sourceMessageId: prefill.sourceMessageId,
      });
      onClose();
      if (onCreated) onCreated(t);
      else {
        toast.success(assignee?.type === "agent" ? `Tarefa #${t.number} criada. O agente já foi avisado.` : `Tarefa #${t.number} criada.`);
        if (prefill.sourceMessageId) navigate(paths.tasks(ws, t.id));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Nova tarefa"
      description={prefill.sourceMessageId ? "Criada a partir de uma mensagem do chat." : undefined}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-subtle max-md:hidden">Ctrl + Enter cria</span>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Criar tarefa
          </Button>
        </>
      }
    >
      <form
        onSubmit={submit}
        className="flex flex-col gap-4"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
        }}
      >
        <Field label="Título">
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} data-autofocus placeholder="Ex.: Revisar o contrato da Padaria Sol" />}
        </Field>
        <Field label="Descrição" hint="Aceita markdown.">
          {(id, d) => <Textarea id={id} aria-describedby={d} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20_000} className="min-h-28" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Coluna">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Prioridade">
            {(id) => (
              <Select id={id} value={priority} onChange={(e) => setPriority(e.target.value as TaskDTO["priority"])}>
                {(["high", "medium", "low"] as const).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Responsável</span>
            <AssigneeButton value={assignee} onChange={setAssignee} className="h-10 w-full justify-start" />
          </div>
          <Field label="Projeto">
            {(id) => (
              <>
                <Input id={id} value={project} onChange={(e) => setProject(e.target.value)} list="tb-task-projects" maxLength={60} placeholder="Opcional" />
                <datalist id="tb-task-projects">
                  {distinctProjects(all).map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </div>
        <LabelsInput value={labels} onChange={setLabels} suggestions={distinctLabels(all)} />
        <InlineError message={error} />
      </form>
    </Modal>
  );
}
