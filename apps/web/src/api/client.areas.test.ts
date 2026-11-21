import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiClientError } from "./client";

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const { status = 200, body } = handler(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return { api: new ApiClient({ fetch: fn }), calls };
}

describe("tarefas", () => {
  it("lista com filtros e cria/atualiza/move", async () => {
    const { api, calls } = fakeFetch((url) => ({ status: url.endsWith("/tasks") ? 201 : 200, body: url.includes("?") ? { items: [{ id: "t1" }] } : { task: { id: "t1" } } }));
    expect(await api.listTasks("w", { assignee: "agent:a1", label: "urgente", q: "deploy" })).toEqual([{ id: "t1" }]);
    expect(calls[0]!.url).toBe("/api/workspaces/w/tasks?assignee=agent%3Aa1&label=urgente&q=deploy");
    await api.createTask("w", { title: "X", assignee: { type: "user", id: "u1" } });
    expect(calls[1]).toMatchObject({ method: "POST", url: "/api/workspaces/w/tasks", body: { title: "X", assignee: { type: "user", id: "u1" } } });
    expect((await api.updateTask("w", "t1", { status: "doing", position: 1536 })).id).toBe("t1");
    expect(calls[2]).toMatchObject({ method: "PATCH", url: "/api/workspaces/w/tasks/t1", body: { status: "doing", position: 1536 } });
  });
  it("comentários e continuar paradas", async () => {
    const { api, calls } = fakeFetch((url, init) =>
      url.endsWith("resume-stalled") ? { body: { count: 2 } } : init.method === "POST" ? { status: 201, body: { id: "c1", body: "oi" } } : { body: { items: [] } },
    );
    expect((await api.addTaskComment("w", "t1", "@tito olha")).id).toBe("c1");
    expect(calls[0]!.body).toEqual({ body: "@tito olha" });
    expect(await api.listTaskComments("w", "t1")).toEqual([]);
    expect(await api.resumeStalledTasks("w")).toEqual({ count: 2 });
    const hubShape = fakeFetch(() => ({ body: { stalled: 3, items: [{ id: "j1" }, { id: "j2" }] } }));
    expect(await hubShape.api.resumeStalledTasks("w")).toEqual({ count: 2 });
  });
  it("continuar paradas sem contagem no corpo", async () => {
    const { api } = fakeFetch(() => ({ status: 204 }));
    expect(await api.resumeStalledTasks("w")).toEqual({ count: null });
  });
});

describe("wiki", () => {
  it("salva com baseVersion e expõe o 409", async () => {
    const { api, calls } = fakeFetch(() => ({ status: 409, body: { error: { code: "version_conflict", message: "Outra pessoa editou." } } }));
    const err = await api.updateWikiPage("w", "p1", { body: "novo", baseVersion: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(409);
    expect(calls[0]).toMatchObject({ method: "PATCH", url: "/api/workspaces/w/wiki/p1", body: { body: "novo", baseVersion: 3 } });
  });
  it("lixeira, apagar de vez, estatísticas e grafo com padrões", async () => {
    const { api, calls } = fakeFetch((url) => ({ body: url.includes("stats") ? { readsThisWeek: 4 } : url.includes("graph") ? {} : { items: [] } }));
    await api.listWiki("w", { trash: true });
    await api.deleteWikiPage("w", "p1", { permanent: true });
    expect(calls.map((c) => c.url)).toEqual(["/api/workspaces/w/wiki?trash=1", "/api/workspaces/w/wiki/p1?permanent=1"]);
    expect(await api.getWikiStats("w", "p1")).toEqual({ readsThisWeek: 4, readers: [], mentionedIn: [] });
    expect(await api.getWikiGraph("w")).toEqual({ nodes: [], edges: [] });
  });
});

describe("drive, rotinas, skills e conectores", () => {
  it("monta as rotas certas", async () => {
    const { api, calls } = fakeFetch(() => ({ body: { items: [] } }));
    await api.listFiles("w", { folder: "Relatórios" });
    await api.updateFile("w", "f1", { folder: null });
    await api.listRoutines("w", { agentId: "a1" });
    await api.runRoutine("w", "r1");
    await api.updateConnector("w", "c1", { name: "GitHub" });
    await api.deleteSkill("w", "s1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/workspaces/w/files?folder=Relat%C3%B3rios",
      "PATCH /api/workspaces/w/files/f1",
      "GET /api/workspaces/w/routines?agentId=a1",
      "POST /api/workspaces/w/routines/r1/run",
      "PATCH /api/workspaces/w/connectors/c1",
      "DELETE /api/workspaces/w/skills/s1",
    ]);
    expect(calls[1]!.body).toEqual({ folder: null });
  });
});

describe("push, telegram e time inicial", () => {
  it("404 vira null (recurso desligado no hub)", async () => {
    const { api } = fakeFetch(() => ({ status: 404, body: { error: { code: "not_found", message: "x" } } }));
    expect(await api.getPushPublicKey()).toBeNull();
    expect(await api.getTelegramLink()).toBeNull();
  });
  it("outros erros continuam sendo erro", async () => {
    const { api } = fakeFetch(() => ({ status: 500 }));
    await expect(api.getTelegramLink()).rejects.toBeInstanceOf(ApiClientError);
  });
  it("time inicial completa campos ausentes", async () => {
    const { api, calls } = fakeFetch(() => ({ status: 201, body: { agents: [{ id: "a1" }], channels: [] } }));
    const r = await api.createStarterTeam("w", { business: "Agência" });
    expect(r).toMatchObject({ template: "generico", createdAgents: 1, createdChannels: 0 });
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/workspaces/w/starter-team", body: { business: "Agência" } });
  });
  it("mensagem avulsa por id", async () => {
    const { api, calls } = fakeFetch(() => ({ body: { message: { id: "m1" } } }));
    expect((await api.getMessage("w", "m1")).id).toBe("m1");
    expect(calls[0]!.url).toBe("/api/workspaces/w/messages/m1");
  });
});
