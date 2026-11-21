import { describe, expect, it } from "vitest";
import { applyMoves, column, DAY_MS, filterTasks, keyboardTarget, planMove, POSITION_STEP, stalledDays, taskCounters } from "./kanban";
import { task } from "../test/fixtures";

const board = () => [
  task({ id: "a", number: 1, status: "todo", position: 1024 }),
  task({ id: "b", number: 2, status: "todo", position: 2048 }),
  task({ id: "c", number: 3, status: "todo", position: 3072 }),
  task({ id: "d", number: 4, status: "doing", position: 1024 }),
];
const byId = (l: ReturnType<typeof board>) => Object.fromEntries(l.map((t) => [t.id, t]));

describe("planMove", () => {
  it("usa o ponto médio entre as vizinhas", () => {
    expect(planMove(board(), "c", "todo", 1)).toEqual([{ id: "c", status: "todo", position: 1536 }]);
  });
  it("move para o fim e para o começo de outra coluna", () => {
    expect(planMove(board(), "a", "doing", 1)).toEqual([{ id: "a", status: "doing", position: 1024 + POSITION_STEP }]);
    expect(planMove(board(), "a", "doing", 0)).toEqual([{ id: "a", status: "doing", position: 512 }]);
  });
  it("coluna vazia recebe a posição inicial", () => {
    expect(planMove(board(), "b", "review", 0)).toEqual([{ id: "b", status: "review", position: POSITION_STEP }]);
  });
  it("não faz nada quando solta no mesmo lugar", () => {
    expect(planMove(board(), "b", "todo", 1)).toEqual([]);
    expect(planMove(board(), "zzz", "todo", 0)).toEqual([]);
  });
  it("renumera a coluna quando não há espaço entre as vizinhas", () => {
    const tight = [task({ id: "x", status: "todo", position: 10 }), task({ id: "y", status: "todo", position: 11 }), task({ id: "z", status: "doing", position: 5 })];
    const up = planMove(tight, "z", "todo", 1);
    expect(up[0]).toEqual({ id: "z", status: "todo", position: 2 * POSITION_STEP });
    expect(up).toContainEqual({ id: "x", status: "todo", position: POSITION_STEP });
    expect(up).toContainEqual({ id: "y", status: "todo", position: 3 * POSITION_STEP });
    const after = Object.values(applyMoves(byId(tight as never), up));
    expect(column(after, "todo").map((t) => t.id)).toEqual(["x", "z", "y"]);
  });
  it("aplicar o plano produz a ordem pedida", () => {
    const tasks = board();
    const next = Object.values(applyMoves(byId(tasks), planMove(tasks, "a", "todo", 2)));
    expect(column(next, "todo").map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("keyboardTarget", () => {
  it("sobe, desce e troca de coluna", () => {
    const t = board();
    expect(keyboardTarget(t, "b", "up")).toEqual({ status: "todo", index: 0 });
    expect(keyboardTarget(t, "b", "down")).toEqual({ status: "todo", index: 2 });
    expect(keyboardTarget(t, "a", "up")).toBeNull();
    expect(keyboardTarget(t, "c", "right")).toEqual({ status: "doing", index: 1 });
    expect(keyboardTarget(t, "a", "left")).toBeNull();
  });
});

describe("filtros, contadores e paradas", () => {
  const tasks = [
    task({ id: "1", number: 7, title: "Revisar contrato", labels: ["jurídico"], project: "Clientes", assignee: { type: "agent", id: "ag" } }),
    task({ id: "2", title: "Deploy", status: "doing", assignee: { type: "user", id: "u1" } }),
    task({ id: "3", title: "Ação", status: "done" }),
    task({ id: "4", title: "Pendência sem dono" }),
  ];
  it("filtra por projeto, responsável, etiqueta e busca sem acento", () => {
    expect(filterTasks(tasks, { project: "Clientes" }).map((t) => t.id)).toEqual(["1"]);
    expect(filterTasks(tasks, { assignee: "none" }).map((t) => t.id)).toEqual(["3", "4"]);
    expect(filterTasks(tasks, { label: "jurídico" }).map((t) => t.id)).toEqual(["1"]);
    expect(filterTasks(tasks, { q: "acao" }).map((t) => t.id)).toEqual(["3"]);
    expect(filterTasks(tasks, { q: "#7" }).map((t) => t.id)).toEqual(["1"]);
  });
  it("conta em aberto, com agentes e sem responsável (ignora feitas)", () => {
    expect(taskCounters(tasks)).toEqual({ open: 3, withAgents: 1, unassigned: 1 });
  });
  it("só conta como parada a tarefa em andamento sem mudança há 1 dia ou mais", () => {
    const now = 10 * DAY_MS;
    expect(stalledDays({ status: "doing", updatedAt: now - 3 * DAY_MS - 5 }, now)).toBe(3);
    expect(stalledDays({ status: "doing", updatedAt: now - DAY_MS + 5 }, now)).toBe(0);
    expect(stalledDays({ status: "todo", updatedAt: 0 }, now)).toBe(0);
  });
});

import { prefillFromMessage } from "./kanban";
describe("prefillFromMessage", () => {
  it("usa a primeira linha como título e cita a mensagem na descrição", () => {
    const p = prefillFromMessage("**Revisar** o contrato\n\nCom urgência");
    expect(p.title).toBe("Revisar o contrato");
    expect(p.description).toBe("> **Revisar** o contrato\n> \n> Com urgência");
  });
  it("encurta títulos longos sem cortar palavra", () => {
    const p = prefillFromMessage("palavra ".repeat(30));
    expect(p.title.length).toBeLessThanOrEqual(90);
    expect(p.title.endsWith("palavra…")).toBe(true);
  });
});

describe("resolveTaskRef", () => {
  const tasks = { "t-1": { id: "t-1", number: 7 }, "t-2": { id: "t-2", number: 12 } };
  it("aceita id e número (com ou sem #), como nos links das notificações", async () => {
    const { resolveTaskRef } = await import("./kanban");
    expect(resolveTaskRef("t-2", tasks, true)).toBe("t-2");
    expect(resolveTaskRef("12", tasks, true)).toBe("t-2");
    expect(resolveTaskRef("#7", tasks, true)).toBe("t-1");
    expect(resolveTaskRef(null, tasks, true)).toBeNull();
  });
  it("espera o quadro carregar antes de dizer que o número não existe", async () => {
    const { resolveTaskRef } = await import("./kanban");
    expect(resolveTaskRef("99", {}, false)).toBeNull();
    expect(resolveTaskRef("99", tasks, true)).toBe("99");
  });
});
