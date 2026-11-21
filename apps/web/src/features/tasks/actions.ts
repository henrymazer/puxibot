/** Ações de tarefas: chamam a API e mantêm `useWorkspace.tasks` atualizado (com atualização otimista). */
import type { TaskDTO } from "@puxibot/shared";
import { api } from "../../api";
import type { CreateTaskInput, TaskPatch } from "../../api/client";
import { useWorkspace } from "../../store/workspace";
import { applyMoves, planMove, type MoveUpdate } from "../../lib/kanban";
import type { TaskStatus } from "@puxibot/shared";

const ws = () => useWorkspace.getState().wsId!;

/** Grava a versão que o servidor devolveu (sem o filtro de eventos atrasados). */
export function putTask(t: TaskDTO) {
  if (!t || !t.id) return;
  useWorkspace.setState((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
}

export async function createTask(input: CreateTaskInput): Promise<TaskDTO> {
  const t = await api.createTask(ws(), input);
  putTask(t);
  return t;
}

export async function patchTask(task: TaskDTO, patch: TaskPatch): Promise<TaskDTO> {
  const before = useWorkspace.getState().tasks[task.id] ?? task;
  putTask({ ...before, ...patch } as TaskDTO);
  try {
    const t = await api.updateTask(ws(), task.id, patch);
    putTask(t && t.id ? t : ({ ...before, ...patch } as TaskDTO));
    return t;
  } catch (err) {
    putTask(before);
    throw err;
  }
}

/** Move no quadro e grava as posições. Desfaz tudo se o servidor recusar. */
export async function moveTask(id: string, status: TaskStatus, index: number): Promise<MoveUpdate[]> {
  const state = useWorkspace.getState();
  const updates = planMove(Object.values(state.tasks), id, status, index);
  if (updates.length === 0) return updates;
  const snapshot = state.tasks;
  useWorkspace.setState({ tasks: applyMoves(snapshot, updates) });
  try {
    const saved = await Promise.all(
      updates.map((u) => {
        const prev = snapshot[u.id]!;
        const patch: TaskPatch = prev.status !== u.status ? { status: u.status, position: u.position } : { position: u.position };
        return api.updateTask(ws(), u.id, patch);
      }),
    );
    for (const t of saved) if (t && t.id) putTask(t);
  } catch (err) {
    // Volta só as tarefas deste movimento (outras podem ter mudado por eventos no meio-tempo).
    useWorkspace.setState((s) => {
      const tasks = { ...s.tasks };
      for (const u of updates) if (snapshot[u.id]) tasks[u.id] = snapshot[u.id]!;
      return { tasks };
    });
    throw err;
  }
  return updates;
}

export async function deleteTask(id: string): Promise<void> {
  await api.deleteTask(ws(), id);
  useWorkspace.getState().dispatch({ type: "task.deleted", taskId: id });
}

export { useNewTask, type NewTaskPrefill } from "./newTask";
