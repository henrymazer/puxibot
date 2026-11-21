/**
 * Regras do quadro de tarefas: ordem por `position`, mover entre colunas,
 * filtros, contadores e tarefas paradas. Funções puras, testadas em kanban.test.ts.
 */
import { TASK_STATUSES, type TaskDTO, type TaskStatus } from "@puxibot/shared";

export const POSITION_STEP = 1024;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "A fazer",
  doing: "Em andamento",
  review: "Em revisão",
  done: "Feito",
};
export const PRIORITY_LABEL: Record<TaskDTO["priority"], string> = { low: "Baixa", medium: "Média", high: "Alta" };

export function comparePosition(a: TaskDTO, b: TaskDTO): number {
  return a.position - b.position || a.createdAt - b.createdAt || a.number - b.number;
}

/** Tarefas de uma coluna, na ordem do quadro. */
export function column(tasks: TaskDTO[], status: TaskStatus): TaskDTO[] {
  return tasks.filter((t) => t.status === status).sort(comparePosition);
}

export function groupByStatus(tasks: TaskDTO[]): Record<TaskStatus, TaskDTO[]> {
  const out = {} as Record<TaskStatus, TaskDTO[]>;
  for (const s of TASK_STATUSES) out[s] = column(tasks, s);
  return out;
}

export interface MoveUpdate {
  id: string;
  status: TaskStatus;
  position: number;
}

/**
 * Planeja mover a tarefa `id` para a coluna `status`, na posição `index`
 * (contada entre as tarefas da coluna, sem a que está sendo movida).
 * Usa o ponto médio entre as vizinhas; quando não há espaço, renumera a coluna.
 * Devolve as tarefas que precisam ser gravadas, começando pela movida.
 * Lista vazia = nada mudou.
 */
export function planMove(tasks: TaskDTO[], id: string, status: TaskStatus, index: number): MoveUpdate[] {
  const moving = tasks.find((t) => t.id === id);
  if (!moving) return [];
  const col = column(tasks, status).filter((t) => t.id !== id);
  const i = Math.max(0, Math.min(index, col.length));

  // Mesmo lugar de antes: nada a fazer.
  if (moving.status === status) {
    const current = column(tasks, status).findIndex((t) => t.id === id);
    if (current === i) return [];
  }

  const before = col[i - 1];
  const after = col[i];
  let position: number | null;
  if (!before && !after) position = POSITION_STEP;
  else if (!before) position = after!.position > 1 ? Math.floor(after!.position / 2) : null;
  else if (!after) position = before.position + POSITION_STEP;
  else {
    const mid = Math.floor((before.position + after.position) / 2);
    position = mid > before.position && mid < after.position ? mid : null;
  }
  if (position !== null && position > 0) return [{ id, status, position }];

  // Sem espaço entre as vizinhas: renumera a coluna inteira na nova ordem.
  const ordered = [...col.slice(0, i), moving, ...col.slice(i)];
  const updates: MoveUpdate[] = [];
  ordered.forEach((t, k) => {
    const p = (k + 1) * POSITION_STEP;
    if (t.id === id) updates.unshift({ id, status, position: p });
    else if (t.position !== p) updates.push({ id: t.id, status, position: p });
  });
  return updates;
}

/**
 * Aplica as atualizações localmente (atualização otimista).
 * Não mexe em `updatedAt`: quem define é o hub, e o redutor usa esse campo para ignorar eventos atrasados.
 */
export function applyMoves(tasks: Record<string, TaskDTO>, updates: MoveUpdate[]): Record<string, TaskDTO> {
  const out = { ...tasks };
  for (const u of updates) {
    const t = out[u.id];
    if (t) out[u.id] = { ...t, status: u.status, position: u.position };
  }
  return out;
}

export type MoveDirection = "up" | "down" | "left" | "right";

/** Destino ao mover pelo teclado: cima/baixo na coluna, esquerda/direita entre colunas. */
export function keyboardTarget(tasks: TaskDTO[], id: string, dir: MoveDirection): { status: TaskStatus; index: number } | null {
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  const col = column(tasks, t.status);
  const idx = col.findIndex((x) => x.id === id);
  const si = TASK_STATUSES.indexOf(t.status);
  if (dir === "up") return idx > 0 ? { status: t.status, index: idx - 1 } : null;
  if (dir === "down") return idx < col.length - 1 ? { status: t.status, index: idx + 1 } : null;
  const next = TASK_STATUSES[si + (dir === "left" ? -1 : 1)];
  if (!next) return null;
  const target = column(tasks, next);
  return { status: next, index: Math.min(idx, target.length) };
}

// ---------- Filtros e contadores ----------
export interface TaskFilters {
  project?: string;
  /** "user:<id>", "agent:<id>", "none" ou vazio. */
  assignee?: string;
  label?: string;
  q?: string;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function assigneeKey(t: Pick<TaskDTO, "assignee">): string {
  return t.assignee ? `${t.assignee.type}:${t.assignee.id}` : "none";
}

export function filterTasks(tasks: TaskDTO[], f: TaskFilters): TaskDTO[] {
  const q = f.q ? norm(f.q.trim()) : "";
  return tasks.filter((t) => {
    if (f.project && (t.project ?? "") !== f.project) return false;
    if (f.assignee && assigneeKey(t) !== f.assignee) return false;
    if (f.label && !t.labels.includes(f.label)) return false;
    if (q) {
      const hay = norm(`#${t.number} ${t.title} ${t.description} ${t.labels.join(" ")}`);
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function taskCounters(tasks: TaskDTO[]): { open: number; withAgents: number; unassigned: number } {
  let open = 0;
  let withAgents = 0;
  let unassigned = 0;
  for (const t of tasks) {
    if (t.status === "done") continue;
    open++;
    if (!t.assignee) unassigned++;
    else if (t.assignee.type === "agent") withAgents++;
  }
  return { open, withAgents, unassigned };
}

/** Dias parada: só tarefas "Em andamento" sem mudança há pelo menos 1 dia (mesma regra do "Continuar todas"). */
export function stalledDays(t: Pick<TaskDTO, "status" | "updatedAt">, now = Date.now()): number {
  if (t.status !== "doing") return 0;
  const d = Math.floor((now - t.updatedAt) / DAY_MS);
  return d >= 1 ? d : 0;
}

export function stalledTasks(tasks: TaskDTO[], now = Date.now()): TaskDTO[] {
  return tasks.filter((t) => stalledDays(t, now) > 0);
}

/** Valores distintos para os filtros. */
export function distinctProjects(tasks: TaskDTO[]): string[] {
  return [...new Set(tasks.map((t) => t.project).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}
export function distinctLabels(tasks: TaskDTO[]): string[] {
  return [...new Set(tasks.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Título e descrição sugeridos a partir do texto de uma mensagem. */
export function prefillFromMessage(body: string): { title: string; description: string } {
  const clean = body.replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#]/g, "").trim();
  const firstLine = clean.split(/\n+/).find((l) => l.trim()) ?? "";
  let title = firstLine.trim();
  if (title.length > 90) title = `${title.slice(0, 87).replace(/\s+\S*$/, "")}…`;
  const quoted = body
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return { title, description: quoted };
}

/**
 * `?tarefa=` aceita o id da tarefa ou o número dela (`12` ou `#12`): os links das notificações
 * do hub usam o número. Devolve o id; `null` enquanto o quadro carrega e o número ainda não
 * pode ser resolvido. Número sem tarefa correspondente devolve o próprio valor (o painel mostra
 * "não encontrada").
 */
export function resolveTaskRef(ref: string | null, tasks: Record<string, Pick<TaskDTO, "id" | "number">>, loaded: boolean): string | null {
  if (!ref) return null;
  if (tasks[ref]) return ref;
  const m = /^#?(\d+)$/.exec(ref.trim());
  if (!m) return ref;
  const n = Number(m[1]);
  const found = Object.values(tasks).find((t) => t.number === n);
  if (found) return found.id;
  return loaded ? ref : null;
}
