import { useEffect, useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { ArrowLeft, CircleDot, ExternalLink, GitPullRequest, Link2, MessageSquareText, MoreVertical, Plus, Send, Trash2, X } from "lucide-react";
import { TASK_STATUSES, type TaskCommentDTO, type TaskDTO, type TaskStatus } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, InlineError, Input, LoadingState, Select, Spinner, Textarea } from "../../components/ui";
import { MenuItem, Popover } from "../../components/Popover";
import { toast } from "../../components/toast";
import { Markdown } from "../chat/Markdown";
import { authorshipLabel, isAdmin } from "../../lib/actors";
import { formatDateTime, formatRelative } from "../../lib/format";
import { distinctLabels, distinctProjects, PRIORITY_LABEL, STATUS_LABEL } from "../../lib/kanban";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { safeLink } from "../../lib/safeLink";
import { ActorAvatar, AssigneeButton, MentionTextarea, StalledNote } from "./TaskBits";
import { LabelsInput } from "./LabelsInput";
import { deleteTask, patchTask, putTask } from "./actions";

export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const task = useWorkspace((s) => s.tasks[taskId]);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (task) return;
    setError(null);
    api
      .getTask(ws, taskId)
      .then(putTask)
      .catch((e) => {
        if ((e as { status?: number }).status === 404) setMissing(true);
        else setError(errorMessage(e));
      });
  }, [ws, taskId, task]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label="Detalhes da tarefa"
      className="flex min-w-0 flex-col border-l border-line bg-surface max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:border-0 lg:w-[400px] lg:shrink-0 2xl:w-[460px]"
    >
      {task ? (
        <TaskDetails key={task.id} task={task} onClose={onClose} />
      ) : (
        <>
          <header className="flex min-h-14 items-center gap-2 border-b border-line px-3 pt-[env(safe-area-inset-top)]">
            <IconButton label="Fechar" onClick={onClose}>
              <X className="size-5" />
            </IconButton>
          </header>
          {missing ? (
            <EmptyState title="Tarefa não encontrada" className="mt-12">
              Ela pode ter sido apagada.
            </EmptyState>
          ) : error ? (
            <ErrorState message={error} />
          ) : (
            <LoadingState />
          )}
        </>
      )}
    </aside>
  );
}

function useSave(task: TaskDTO) {
  return (patch: Parameters<typeof patchTask>[1]) => patchTask(task, patch).catch((e) => toast.error(e));
}

function TaskDetails({ task, onClose }: { task: TaskDTO; onClose: () => void }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const tasks = useWorkspace((s) => s.tasks);
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const save = useSave(task);
  const [title, setTitle] = useState(task.title);
  const [project, setProject] = useState(task.project ?? "");
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const all = Object.values(tasks);
  const me = useWorkspace((s) => s.me);
  const canDelete = isAdmin(me?.role) || (task.createdBy.type === "user" && task.createdBy.id === me?.userId);

  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setProject(task.project ?? ""), [task.project]);

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteTask(task.id);
      toast.success(`Tarefa #${task.number} apagada.`);
      onClose();
    } catch (e) {
      toast.error(e);
      setDeleting(false);
    }
  };

  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line px-2 pt-[env(safe-area-inset-top)] md:px-3">
        <IconButton label="Voltar" className="lg:hidden" onClick={onClose}>
          <ArrowLeft className="size-5" />
        </IconButton>
        <div className="min-w-0 flex-1 px-1">
          <p className="text-xs text-muted">
            Tarefa <span className="font-mono">#{task.number}</span>
          </p>
          <p className="truncate text-xs text-subtle">Atualizada {formatRelative(task.updatedAt)}</p>
        </div>
        <IconButton ref={menuAnchor} label="Mais opções da tarefa" onClick={() => setMenu((v) => !v)}>
          <MoreVertical className="size-4.5" />
        </IconButton>
        <IconButton label="Fechar painel" className="max-lg:hidden" onClick={onClose}>
          <X className="size-5" />
        </IconButton>
      </header>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={menuAnchor} align="end" label="Opções da tarefa" className="w-56 py-1">
        <div role="menu">
          <MenuItem
            icon={<Link2 className="size-4" />}
            onClick={() => {
              setMenu(false);
              void navigator.clipboard?.writeText(`${location.origin}${paths.tasks(ws, task.id)}`).then(() => toast.success("Link copiado."));
            }}
          >
            Copiar link
          </MenuItem>
          <MenuItem
            danger
            disabled={!canDelete}
            icon={<Trash2 className="size-4" />}
            onClick={() => {
              setMenu(false);
              setConfirm(true);
            }}
          >
            {canDelete ? "Apagar tarefa" : "Só quem criou ou um admin apaga"}
          </MenuItem>
        </div>
      </Popover>

      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
        <label htmlFor="task-title" className="sr-only">
          Título
        </label>
        <textarea
          id="task-title"
          value={title}
          rows={1}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
          onBlur={() => {
            const t = title.trim();
            if (!t) setTitle(task.title);
            else if (t !== task.title) void save({ title: t });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          className="field-sizing-content w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-lg leading-snug font-semibold hover:border-line focus:border-primary focus:outline-none"
        />
        <StalledNote task={task} className="mt-1 ml-1" />

        <dl className="mt-4 grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-2.5 text-sm max-sm:grid-cols-1 max-sm:gap-y-1">
          <dt className="text-muted max-sm:mt-2">Coluna</dt>
          <dd>
            <Select aria-label="Coluna" value={task.status} onChange={(e) => void save({ status: e.target.value as TaskStatus })} className="h-9 min-h-9 py-1 text-sm max-md:h-11">
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </dd>
          <dt className="text-muted max-sm:mt-2">Prioridade</dt>
          <dd>
            <Select aria-label="Prioridade" value={task.priority} onChange={(e) => void save({ priority: e.target.value as TaskDTO["priority"] })} className="h-9 min-h-9 py-1 text-sm max-md:h-11">
              {(["high", "medium", "low"] as const).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </dd>
          <dt className="text-muted max-sm:mt-2">Responsável</dt>
          <dd className="min-w-0">
            <AssigneeButton value={task.assignee} onChange={(a) => void save({ assignee: a })} className="h-9 w-full justify-start max-md:h-11" />
          </dd>
          <dt className="text-muted max-sm:mt-2">
            <label htmlFor="task-project">Projeto</label>
          </dt>
          <dd>
            <Input
              id="task-project"
              value={project}
              list="tb-panel-projects"
              maxLength={60}
              placeholder="Sem projeto"
              onChange={(e) => setProject(e.target.value)}
              onBlur={() => {
                const p = project.trim();
                if (p !== (task.project ?? "")) void save({ project: p || null });
              }}
              className="h-9 min-h-9 py-1 text-sm max-md:h-11"
            />
            <datalist id="tb-panel-projects">
              {distinctProjects(all).map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </dd>
        </dl>
        <div className="mt-3">
          <LabelsInput value={task.labels} onChange={(labels) => void save({ labels })} suggestions={distinctLabels(all)} />
        </div>

        <Description task={task} />
        <Subtasks task={task} />
        <Links task={task} />
        <Origin task={task} />
        <p className="mt-4 text-xs text-subtle">
          Criada por {authorshipLabel({ members, agents }, task.createdBy, task.onBehalfOfUserId)} em {formatDateTime(task.createdAt)}
        </p>
        <Comments task={task} />
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void remove()}
        loading={deleting}
        danger
        title={`Apagar a tarefa #${task.number}?`}
        body="Os comentários e subtarefas somem junto. Não dá para desfazer."
        confirmLabel="Apagar"
      />
    </>
  );
}

function SectionHeading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mt-6 mb-2 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{children}</h3>
      {action}
    </div>
  );
}

function Description({ task }: { task: TaskDTO }) {
  const save = useSave(task);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  const [busy, setBusy] = useState(false);
  const agents = useWorkspace((s) => s.agents);
  const handles = new Set(Object.values(agents).map((a) => a.handle));
  return (
    <>
      <SectionHeading
        action={
          !editing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(task.description);
                setEditing(true);
              }}
            >
              {task.description ? "Editar" : "Escrever"}
            </Button>
          )
        }
      >
        Descrição
      </SectionHeading>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Descrição em markdown"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            maxLength={20_000}
            className="min-h-40 font-mono text-sm"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-subtle">Markdown: **negrito**, listas com -, `código`.</span>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={() => {
                setBusy(true);
                void save({ description: draft }).finally(() => {
                  setBusy(false);
                  setEditing(false);
                });
              }}
            >
              Salvar
            </Button>
          </div>
        </div>
      ) : task.description ? (
        <div className="text-sm leading-relaxed">
          <Markdown text={task.description} agentHandles={handles} />
        </div>
      ) : (
        <p className="text-sm text-subtle">Sem descrição.</p>
      )}
    </>
  );
}

function Subtasks({ task }: { task: TaskDTO }) {
  const save = useSave(task);
  const [draft, setDraft] = useState("");
  const done = task.subtasks.filter((s) => s.done).length;
  const update = (subtasks: TaskDTO["subtasks"]) => void save({ subtasks });
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    update([...task.subtasks, { id: `st_${Date.now().toString(36)}`, title: t.slice(0, 200), done: false }]);
    setDraft("");
  };
  return (
    <>
      <SectionHeading action={task.subtasks.length > 0 && <span className="text-xs text-muted tabular-nums">{done} de {task.subtasks.length}</span>}>Subtarefas</SectionHeading>
      {task.subtasks.length > 0 && (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${(done / task.subtasks.length) * 100}%` }} />
        </div>
      )}
      <ul className="flex flex-col">
        {task.subtasks.map((s) => (
          <li key={s.id} className="group flex min-h-9 items-center gap-2 rounded-md px-1 hover:bg-surface-2 max-md:min-h-11">
            <input
              type="checkbox"
              checked={s.done}
              onChange={() => update(task.subtasks.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)))}
              className="size-4 accent-[var(--tb-primary)]"
              aria-label={s.title}
            />
            <span className={cn("min-w-0 flex-1 text-sm break-words", s.done && "text-muted line-through")}>{s.title}</span>
            <IconButton size="sm" label={`Tirar subtarefa ${s.title}`} onClick={() => update(task.subtasks.filter((x) => x.id !== s.id))} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100">
              <X className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>
      <form
        className="mt-1 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Nova subtarefa" aria-label="Nova subtarefa" className="h-9 min-h-9 py-1 text-sm max-md:h-11" />
        <Button type="submit" size="sm" icon={<Plus className="size-4" />} disabled={!draft.trim()}>
          Adicionar
        </Button>
      </form>
    </>
  );
}

function guessKind(url: string): TaskDTO["links"][number]["kind"] {
  if (/\/pull\/\d+|\/merge_requests\/\d+/.test(url)) return "pr";
  if (/\/issues\/\d+/.test(url)) return "issue";
  return "url";
}
function guessLabel(url: string): string {
  const m = /\/(?:pull|issues|merge_requests)\/(\d+)/.exec(url);
  if (m) return `#${m[1]}`;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Só vira link se for http(s) ou caminho da interface; senão mostra o texto (ver lib/safeLink). */
function TaskLink({ url, label }: { url: string; label: string }) {
  const link = safeLink(url);
  if (!link) {
    return (
      <span className="min-w-0 flex-1 truncate text-sm text-muted" title={`Endereço não aceito como link: ${url}`}>
        {label}
      </span>
    );
  }
  if (link.kind === "internal") {
    return (
      <RouterLink to={link.href} className="min-w-0 flex-1 truncate text-sm text-primary-text underline-offset-2 hover:underline">
        {label}
      </RouterLink>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-sm text-primary-text underline-offset-2 hover:underline">
      {label}
      <ExternalLink className="ml-1 inline size-3 align-[-1px]" aria-hidden />
    </a>
  );
}

function Links({ task }: { task: TaskDTO }) {
  const save = useSave(task);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      setError("Cole um endereço completo, começando com https://");
      return;
    }
    void save({ links: [...task.links, { kind: guessKind(u), label: label.trim() || guessLabel(u), url: u }] });
    setUrl("");
    setLabel("");
    setError(null);
    setAdding(false);
  };
  return (
    <>
      <SectionHeading action={!adding && <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>PR ou issue</Button>}>
        Links
      </SectionHeading>
      {task.links.length === 0 && !adding && <p className="text-sm text-subtle">Nenhum PR, issue ou link.</p>}
      <ul className="flex flex-col gap-1">
        {task.links.map((l, i) => (
          <li key={`${l.url}-${i}`} className="group flex min-h-9 items-center gap-2 rounded-md px-1 hover:bg-surface-2">
            {l.kind === "pr" ? <GitPullRequest className="size-4 text-success" aria-label="Pull request" /> : l.kind === "issue" ? <CircleDot className="size-4 text-warning" aria-label="Issue" /> : <Link2 className="size-4 text-muted" aria-label="Link" />}
            <TaskLink url={l.url} label={l.label} />
            <IconButton size="sm" label={`Tirar link ${l.label}`} onClick={() => void save({ links: task.links.filter((_, j) => j !== i) })} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100">
              <X className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>
      {adding && (
        <form
          className="mt-2 flex flex-col gap-2 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/…/pull/42" aria-label="Endereço do link" autoFocus inputMode="url" />
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nome (opcional)" aria-label="Nome do link" maxLength={80} />
          <InlineError message={error} />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" type="submit">
              Adicionar link
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

function Origin({ task }: { task: TaskDTO }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!task.sourceMessageId) return null;
  const go = async () => {
    setBusy(true);
    try {
      const m = await api.getMessage(ws, task.sourceMessageId!);
      navigate(m.threadRootId ? paths.thread(ws, m.channelId, m.threadRootId) : `${paths.channel(ws, m.channelId)}?msg=${m.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={() => void go()} className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-md px-1 text-sm text-primary-text hover:underline">
      {busy ? <Spinner /> : <MessageSquareText className="size-4" aria-hidden />}
      Ver a mensagem que originou a tarefa
    </button>
  );
}

function Comments({ task }: { task: TaskDTO }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const [items, setItems] = useState<TaskCommentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const handles = new Set(Object.values(agents).map((a) => a.handle));

  // Recarrega quando o contador muda (comentário novo de outra pessoa ou agente).
  useEffect(() => {
    let alive = true;
    api
      .listTaskComments(ws, task.id)
      .then((list) => alive && setItems(list.sort((a, b) => a.createdAt - b.createdAt)))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [ws, task.id, task.commentCount]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const c = await api.addTaskComment(ws, task.id, body);
      setItems((l) => (l && c?.id && !l.some((x) => x.id === c.id) ? [...l, c] : l));
      setDraft("");
      const mentionsAgent = Object.values(agents).some((a) => new RegExp(`(^|\\W)@${a.handle}\\b`, "i").test(body));
      if (mentionsAgent) toast.success("Comentário enviado. O agente mencionado foi avisado.");
    } catch (e) {
      toast.error(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <SectionHeading>Comentários</SectionHeading>
      {error ? (
        <InlineError message={error} />
      ) : items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="text-sm text-subtle">Nenhum comentário ainda.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {items.map((c) => (
            <li key={c.id} className="flex gap-2.5">
              <ActorAvatar actor={c.author} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-semibold">{authorshipLabel({ members, agents }, c.author, c.onBehalfOfUserId)}</span>
                  {c.author.type === "agent" && <span className="rounded-xs bg-agent-soft px-1 text-[10px] font-semibold text-agent uppercase">agente</span>}
                  <time className="text-xs text-subtle" title={formatDateTime(c.createdAt)}>
                    {formatRelative(c.createdAt)}
                  </time>
                </p>
                <div className="text-sm leading-relaxed">
                  <Markdown text={c.body} agentHandles={handles} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 flex flex-col gap-2">
        <MentionTextarea value={draft} onValue={setDraft} onSubmit={() => void send()} placeholder="Comente ou chame um agente com @" aria-label="Novo comentário" maxLength={20_000} className="text-sm" />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-subtle max-md:hidden">Ctrl + Enter envia</span>
          <Button size="sm" variant="primary" icon={<Send className="size-4" />} loading={sending} disabled={!draft.trim()} onClick={() => void send()}>
            Comentar
          </Button>
        </div>
      </div>
    </>
  );
}
