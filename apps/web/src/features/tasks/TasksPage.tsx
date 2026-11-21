import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Filter, KanbanSquare, List, Play, Plus, Search, X } from "lucide-react";
import type { TaskStatus } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { Button, EmptyState, ErrorState, IconButton, Kbd, LoadingState, Select } from "../../components/ui";
import { toast } from "../../components/toast";
import { distinctLabels, distinctProjects, filterTasks, resolveTaskRef, stalledTasks, taskCounters, type TaskFilters } from "../../lib/kanban";
import { cn } from "../../lib/cn";
import { PageHeader } from "../shell/PageHeader";
import { Segmented } from "../agents/shared";
import { TaskBoard } from "./TaskBoard";
import { TaskListView } from "./TaskListView";
import { TaskPanel } from "./TaskPanel";
import { useNewTask } from "./actions";

type View = "quadro" | "lista";
const VIEW_KEY = "tb-tasks-view";
const FILTER_KEY = "tb-tasks-filters";

function readSession<T>(key: string, fallback: T): T {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeSession(key: string, v: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

export function TasksPage() {
  const tasksMap = useWorkspace((s) => s.tasks);
  const loaded = useWorkspace((s) => s.tasksLoaded);
  const loadTasks = useWorkspace((s) => s.loadTasks);
  const ws = useWorkspace((s) => s.wsId)!;
  const myUserId = useWorkspace((s) => s.myUserId);
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const openNew = useNewTask((s) => s.open);
  const [params, setParams] = useSearchParams();
  // Links das notificações usam o número da tarefa; a interface usa o id.
  const selected = resolveTaskRef(params.get("tarefa"), tasksMap, loaded);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => readSession<View>(VIEW_KEY, "quadro"));
  const [filters, setFilters] = useState<TaskFilters>(() => readSession<TaskFilters>(FILTER_KEY, {}));
  const [showFilters, setShowFilters] = useState(false);
  const [mobileColumn, setMobileColumn] = useState<TaskStatus>("doing");
  const [resuming, setResuming] = useState(false);

  const load = () => {
    setError(null);
    loadTasks().catch((e) => setError(errorMessage(e)));
  };
  // Sempre recarrega ao abrir: o quadro pode ter mudado enquanto a tela estava fechada.
  useEffect(load, [ws]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => writeSession(VIEW_KEY, view), [view]);
  useEffect(() => writeSession(FILTER_KEY, filters), [filters]);

  // Atalho N = nova tarefa.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isTyping(document.activeElement) || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      openNew({ status: "todo" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNew]);

  const all = useMemo(() => Object.values(tasksMap), [tasksMap]);
  const visible = useMemo(() => filterTasks(all, filters), [all, filters]);
  const counters = taskCounters(all);
  const stalled = stalledTasks(all);
  const resumable = stalled.filter((t) => t.assignee?.type === "agent").length;
  const filtering = !!(filters.q || filters.project || filters.assignee || filters.label);
  const activeFilters = [filters.project, filters.assignee, filters.label].filter(Boolean).length;

  const openTask = (id: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("tarefa", id);
      return n;
    });
  const closeTask = () =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("tarefa");
      return n;
    });

  const resume = async () => {
    setResuming(true);
    try {
      const { count } = await api.resumeStalledTasks(ws);
      const n = count ?? resumable;
      toast.success(n === 0 ? "Nenhuma tarefa parada com agente para continuar." : n === 1 ? "Pedimos ao agente para continuar 1 tarefa." : `Pedimos aos agentes para continuarem ${n} tarefas.`);
      void loadTasks();
    } catch (e) {
      toast.error(e);
    } finally {
      setResuming(false);
    }
  };

  const assigneeOptions = useMemo(() => {
    const people = Object.values(members).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    const bots = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return { people, bots };
  }, [members, agents]);

  const set = (patch: Partial<TaskFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const filterSelects = (
    <>
      <Select aria-label="Projeto" value={filters.project ?? ""} onChange={(e) => set({ project: e.target.value || undefined })} className="h-9 min-h-9 w-44 py-1 text-sm max-md:h-11 max-md:w-full">
        <option value="">Todos os projetos</option>
        {distinctProjects(all).map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </Select>
      <Select aria-label="Responsável" value={filters.assignee ?? ""} onChange={(e) => set({ assignee: e.target.value || undefined })} className="h-9 min-h-9 w-52 py-1 text-sm max-md:h-11 max-md:w-full">
        <option value="">Qualquer responsável</option>
        {myUserId && <option value={`user:${myUserId}`}>Comigo</option>}
        <option value="none">Sem responsável</option>
        <optgroup label="Agentes">
          {assigneeOptions.bots.map((a) => (
            <option key={a.id} value={`agent:${a.id}`}>
              {a.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Pessoas">
          {assigneeOptions.people.map((m) => (
            <option key={m.userId} value={`user:${m.userId}`}>
              {m.name}
            </option>
          ))}
        </optgroup>
      </Select>
      <Select aria-label="Etiqueta" value={filters.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })} className="h-9 min-h-9 w-48 py-1 text-sm max-md:h-11 max-md:w-full">
        <option value="">Todas as etiquetas</option>
        {distinctLabels(all).map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </Select>
    </>
  );

  return (
    <div className="flex h-full min-w-0 flex-1">
      <section className={cn("flex min-w-0 flex-1 flex-col", selected && "max-lg:hidden")} aria-label="Tarefas">
        <PageHeader
          title="Tarefas"
          icon={<KanbanSquare className="size-5" />}
          subtitleWrap={!!selected}
          subtitle={loaded ? `${plural(counters.open, "em aberto", "em aberto")} · ${plural(counters.withAgents, "com agentes", "com agentes")} · ${plural(counters.unassigned, "sem responsável", "sem responsável")}` : undefined}
          actions={
            <>
              <span className="max-sm:hidden">
                <Segmented
                  label="Visão"
                  value={view}
                  onChange={setView}
                  options={[
                    { id: "quadro", label: "Quadro" },
                    { id: "lista", label: "Lista" },
                  ]}
                />
              </span>
              <IconButton label={view === "quadro" ? "Ver em lista" : "Ver em quadro"} onClick={() => setView(view === "quadro" ? "lista" : "quadro")} className="sm:hidden">
                {view === "quadro" ? <List className="size-4.5" /> : <KanbanSquare className="size-4.5" />}
              </IconButton>
              <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => openNew({ status: "todo" })} title="Nova tarefa (N)">
                <span className={selected ? "hidden" : "max-sm:hidden"}>Nova tarefa</span>
                <span className={selected ? "" : "sm:hidden"}>Nova</span>
                {!selected && (
                  <span className="ml-1 max-md:hidden">
                    <Kbd>N</Kbd>
                  </span>
                )}
              </Button>
            </>
          }
        />

        <div className="flex flex-col gap-2 border-b border-line bg-surface px-3 py-2 md:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1 basis-48 md:max-w-xs">
              <span className="sr-only">Buscar tarefas</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden />
              <input className="tb-input h-9 min-h-9 py-1 pl-9 text-sm max-md:h-11" placeholder="Buscar por título ou #número" value={filters.q ?? ""} onChange={(e) => set({ q: e.target.value || undefined })} />
            </label>
            <div className="hidden flex-wrap items-center gap-2 md:flex">{filterSelects}</div>
            <Button size="sm" variant={activeFilters ? "subtle" : "ghost"} icon={<Filter className="size-4" />} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} className="md:hidden">
              Filtros{activeFilters ? ` (${activeFilters})` : ""}
            </Button>
            {filtering && (
              <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setFilters({})}>
                <span className="max-sm:sr-only">Limpar</span>
              </Button>
            )}
          </div>
          {showFilters && <div className="grid gap-2 md:hidden">{filterSelects}</div>}
        </div>

        {stalled.length > 0 && (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/30 bg-warning-soft px-3 py-2 text-sm md:px-5">
            <span className="font-medium text-warning">{stalled.length === 1 ? "1 tarefa parada" : `${stalled.length} tarefas paradas`}</span>
            <span className="text-muted max-sm:hidden">Em andamento há mais de um dia sem mudança.</span>
            <span className="flex-1" />
            <Button
              size="sm"
              icon={<Play className="size-4" />}
              loading={resuming}
              onClick={() => void resume()}
              disabled={resumable === 0}
              title={resumable === 0 ? "Nenhuma delas está com um agente" : undefined}
            >
              Continuar todas
            </Button>
          </div>
        )}

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !loaded ? (
          <LoadingState label="Carregando tarefas…" className="flex-1" />
        ) : all.length === 0 ? (
          <EmptyState
            icon={<KanbanSquare className="size-5" />}
            title="Nenhuma tarefa ainda"
            className="mt-12"
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openNew({ status: "todo" })}>
                Criar a primeira tarefa
              </Button>
            }
          >
            Crie tarefas para pessoas ou agentes. Atribuir a um agente faz ele começar a trabalhar.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="Nada com esses filtros" className="mt-12" action={<Button onClick={() => setFilters({})}>Limpar filtros</Button>} />
        ) : view === "quadro" ? (
          <TaskBoard
            tasks={visible}
            allTasks={all}
            onOpen={openTask}
            onCreate={(status) => openNew({ status })}
            mobileColumn={mobileColumn}
            onMobileColumn={setMobileColumn}
            compact={!!selected}
            selectedId={selected}
          />
        ) : (
          <TaskListView tasks={visible} onOpen={openTask} selectedId={selected} />
        )}
      </section>
      {selected && <TaskPanel taskId={selected} onClose={closeTask} />}
    </div>
  );
}
