import { describe, expect, it } from "vitest";
import { applyBootstrap, applyEvent, emptyData, type DataState } from "./reducer";
import { bootstrap, file, msg, task } from "../test/fixtures";

const ready = (): DataState => applyBootstrap(emptyData(), bootstrap());

describe("eventos de tarefas", () => {
  it("task.upserted insere e substitui; ignora versão mais velha", () => {
    let s = ready();
    s = applyEvent(s, { type: "task.upserted", task: task({ id: "t1", title: "A", updatedAt: 10 }) }, 0);
    expect(s.tasks.t1!.title).toBe("A");
    s = applyEvent(s, { type: "task.upserted", task: task({ id: "t1", title: "B", status: "doing", updatedAt: 20 }) }, 0);
    expect(s.tasks.t1).toMatchObject({ title: "B", status: "doing" });
    s = applyEvent(s, { type: "task.upserted", task: task({ id: "t1", title: "velha", updatedAt: 15 }) }, 0);
    expect(s.tasks.t1!.title).toBe("B");
  });

  it("task.deleted remove e é idempotente", () => {
    let s = ready();
    s = applyEvent(s, { type: "task.upserted", task: task({ id: "t1" }) }, 0);
    s = applyEvent(s, { type: "task.deleted", taskId: "t1" }, 0);
    expect(s.tasks.t1).toBeUndefined();
    const again = applyEvent(s, { type: "task.deleted", taskId: "t1" }, 0);
    expect(again).toBe(s);
  });
});

describe("eventos de wiki e drive", () => {
  it("wiki.changed incrementa o contador geral e o da página", () => {
    let s = ready();
    s = applyEvent(s, { type: "wiki.changed", pageId: "p1" }, 0);
    s = applyEvent(s, { type: "wiki.changed", pageId: "p1" }, 0);
    s = applyEvent(s, { type: "wiki.changed", pageId: "p2" }, 0);
    expect(s.wikiVersion).toBe(3);
    expect(s.wikiPageVersions).toEqual({ p1: 2, p2: 1 });
  });

  it("file.created só entra no drive quando inDrive", () => {
    let s = ready();
    s = applyEvent(s, { type: "file.created", file: file({ id: "f1" }) }, 0);
    s = applyEvent(s, { type: "file.created", file: file({ id: "f2", inDrive: false }) }, 0);
    expect(Object.keys(s.files)).toEqual(["f1"]);
  });

  it("message.updated atualiza a raiz de thread buscada à parte", () => {
    let s: DataState = { ...ready(), threadRoots: { r1: msg({ id: "r1", body: "antes" }) } };
    s = applyEvent(s, { type: "message.updated", message: msg({ id: "r1", body: "depois" }) }, 0);
    expect(s.threadRoots.r1!.body).toBe("depois");
  });
});
