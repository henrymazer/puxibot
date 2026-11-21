import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ClientEvent, FileDTO, JobDTO, TaskCommentDTO, TaskDTO, WikiPageDTO, WikiRevisionDTO, WikiStatsDTO } from "@puxibot/shared";
import { call, createAgentFor, createWorkspace, eventually, openBrowserSocket, signup, uniq } from "./helpers";

async function setup() {
  const owner = await signup("Renato Lima");
  const ws = await createWorkspace(owner);
  return { owner, ws, base: `/api/workspaces/${ws.id}` };
}

describe("tarefas", () => {
  it("CRUD, número sequencial, filtros, comentários e eventos", async () => {
    const { owner, ws, base } = await setup();
    const browser = await openBrowserSocket(owner, ws.id);
    const created = await Promise.all(
      ["A", "B", "C", "D"].map((t, i) =>
        owner.post<TaskDTO>(`${base}/tasks`, { title: `Tarefa ${t}`, labels: i % 2 ? ["bug"] : [], project: i < 2 ? "site" : undefined }),
      ),
    );
    expect(created.every((r) => r.status === 201)).toBe(true);
    expect(created.map((r) => r.body.number).sort()).toEqual([1, 2, 3, 4]);
    await browser.waitFor((m) => m.type === "task.upserted");

    const t1 = created[0]!.body;
    const patched = await owner.patch<TaskDTO>(`${base}/tasks/${t1.id}`, {
      status: "doing",
      subtasks: [{ title: "parte 1", done: false }],
      links: [{ kind: "pr", label: "#12", url: "https://github.com/x/y/pull/12" }],
      assignee: { type: "user", id: owner.userId },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: "doing", assignee: { type: "user", id: owner.userId } });
    expect(patched.body.subtasks[0]!.id).toBeTruthy();
    expect(patched.body.links[0]!.kind).toBe("pr");

    const bugs = await owner.get<{ items: TaskDTO[] }>(`${base}/tasks?label=bug`);
    expect(bugs.body.items).toHaveLength(2);
    const site = await owner.get<{ items: TaskDTO[] }>(`${base}/tasks?project=site&status=todo,doing`);
    expect(site.body.items).toHaveLength(2);
    const mine = await owner.get<{ items: TaskDTO[] }>(`${base}/tasks?assignee=me`);
    expect(mine.body.items.map((t) => t.id)).toEqual([t1.id]);
    const q = await owner.get<{ items: TaskDTO[] }>(`${base}/tasks?q=${encodeURIComponent("Tarefa C")}`);
    expect(q.body.items).toHaveLength(1);
    expect((await owner.get(`${base}/tasks?status=xyz`)).status).toBe(400);

    const comment = await owner.post<TaskCommentDTO>(`${base}/tasks/${t1.id}/comments`, { body: "comecei" });
    expect(comment.status).toBe(201);
    const comments = await owner.get<{ items: TaskCommentDTO[] }>(`${base}/tasks/${t1.id}/comments`);
    expect(comments.body.items.map((x) => x.body)).toEqual(["comecei"]);
    expect((await owner.get<TaskDTO>(`${base}/tasks/${t1.id}`)).body.commentCount).toBe(1);

    expect((await owner.del(`${base}/tasks/${t1.id}`)).status).toBe(204);
    await browser.waitFor((m) => m.type === "task.deleted" && m.taskId === t1.id);
    expect((await owner.get(`${base}/tasks/${t1.id}`)).status).toBe(404);
    browser.close();
  });

  it("atribuir a agente e mencionar em comentário cria job com a tarefa no pedido; resume-stalled", async () => {
    const { owner, ws, base } = await setup();
    const marcos = await createAgentFor(owner, ws.id, "Marcos");
    const tito = await createAgentFor(owner, ws.id, "Tito");
    const task = await owner.post<TaskDTO>(`${base}/tasks`, {
      title: "Corrigir login",
      description: "O botão não responde.",
      assignee: { type: "agent", id: marcos.id },
    });
    let jobs = (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${marcos.id}`)).body.items;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ origin: "user", requestedByUserId: owner.userId, taskId: task.body.id, channelId: null });
    expect(jobs[0]!.prompt).toContain(`Tarefa #${task.body.number}: Corrigir login`);
    expect(jobs[0]!.prompt).toContain("O botão não responde.");

    await owner.post(`${base}/tasks/${task.body.id}/comments`, { body: `@${tito.handle} pode revisar?` });
    jobs = (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${tito.id}`)).body.items;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.prompt).toContain("pode revisar?");

    // Parada há 2 dias em "doing": "Continuar todas" cria job para o responsável (se não tiver job ativo).
    await owner.patch(`${base}/tasks/${task.body.id}`, { status: "doing" });
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE agent_id = ?").bind(marcos.id).run();
    await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(Date.now() - 2 * 86_400_000, task.body.id).run();
    const resumed = await owner.post<{ stalled: number; items: JobDTO[] }>(`${base}/tasks/resume-stalled`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.stalled).toBe(1);
    expect(resumed.body.items).toHaveLength(1);
    expect(resumed.body.items[0]!.prompt).toContain("parada há 2 dia");
  });
});

describe("wiki", () => {
  it("árvore, revisões, conflito por baseVersion, lixeira, leituras, stats e grafo", async () => {
    const { owner, ws, base } = await setup();
    const browser = await openBrowserSocket(owner, ws.id);
    const folder = await owner.post<WikiPageDTO>(`${base}/wiki`, { title: "Processos", isFolder: true });
    const page = await owner.post<WikiPageDTO>(`${base}/wiki`, { title: "Deploy", body: "Passo 1", parentId: folder.body.id });
    const other = await owner.post<WikiPageDTO>(`${base}/wiki`, { title: "Onboarding", body: "Leia [[Deploy]] e [[Inexistente]]." });
    expect(page.status).toBe(201);
    await browser.waitFor((m) => m.type === "wiki.changed" && m.pageId === page.body.id);

    const tree = await owner.get<{ items: WikiPageDTO[] }>(`${base}/wiki`);
    expect(tree.body.items.map((p) => p.title).sort()).toEqual(["Deploy", "Onboarding", "Processos"]);
    expect(tree.body.items.every((p) => p.body === "")).toBe(true);

    const v2 = await owner.patch<WikiPageDTO>(`${base}/wiki/${page.body.id}`, { body: "Passo 1 e 2", baseVersion: 1, note: "mais um passo" });
    expect(v2.status).toBe(200);
    expect(v2.body.version).toBe(2);
    const stale = await owner.patch<{ error: { code: string; message: string } }>(`${base}/wiki/${page.body.id}`, { body: "versão velha", baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("wiki_conflict");
    const revs = await owner.get<{ items: WikiRevisionDTO[] }>(`${base}/wiki/${page.body.id}/revisions`);
    expect(revs.body.items.map((r) => r.version)).toEqual([2, 1]);
    expect(revs.body.items[0]!.note).toBe("mais um passo");

    // Mover para dentro de si mesma é recusado.
    expect((await owner.patch(`${base}/wiki/${folder.body.id}`, { parentId: page.body.id })).status).toBe(400);

    const full = await owner.get<WikiPageDTO>(`${base}/wiki/${page.body.id}`);
    expect(full.body.body).toBe("Passo 1 e 2");
    const stats = await owner.get<WikiStatsDTO>(`${base}/wiki/${page.body.id}/stats`);
    expect(stats.body.readsThisWeek).toBe(1);
    expect(stats.body.readers[0]).toMatchObject({ reader: { type: "user", id: owner.userId }, count: 1 });
    expect(stats.body.mentionedIn).toEqual([expect.objectContaining({ kind: "page", id: other.body.id })]);

    const graph = await owner.get<{ nodes: { id: string }[]; edges: { from: string; to: string }[] }>(`${base}/wiki-graph`);
    expect(graph.body.edges).toEqual([{ from: other.body.id, to: page.body.id }]);
    expect(graph.body.nodes).toHaveLength(2);

    // Lixeira leva a pasta e a página de dentro; restaurar traz as duas.
    expect((await owner.del(`${base}/wiki/${folder.body.id}`)).status).toBe(204);
    expect((await owner.get<{ items: WikiPageDTO[] }>(`${base}/wiki`)).body.items.map((p) => p.title)).toEqual(["Onboarding"]);
    expect((await owner.get<{ items: WikiPageDTO[] }>(`${base}/wiki?trash=1`)).body.items).toHaveLength(2);
    const restored = await owner.post<WikiPageDTO>(`${base}/wiki/${folder.body.id}/restore`);
    expect(restored.body.deleted).toBe(false);
    expect((await owner.get<{ items: WikiPageDTO[] }>(`${base}/wiki`)).body.items).toHaveLength(3);

    const member = await signup("Zeca");
    const inv = await owner.post<{ code: string }>(`${base}/invites`, {});
    await member.post(`/api/invites/${inv.body.code}/accept`);
    expect((await member.del(`${base}/wiki/${other.body.id}?permanent=1`)).status).toBe(403);
    expect((await owner.del(`${base}/wiki/${other.body.id}?permanent=1`)).status).toBe(204);
    expect((await owner.get(`${base}/wiki/${other.body.id}`)).status).toBe(404);
    browser.close();
  });
});

async function upload(cookie: string, base: string, fields: Record<string, string>, content: string | Uint8Array, name = "relatorio.txt", type = "text/plain") {
  const form = new FormData();
  form.set("file", new File([content], name, { type }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return call(`${base}/files`, { method: "POST", headers: { Cookie: cookie }, body: form });
}

describe("drive", () => {
  it("upload para o R2, listagem, download em stream, renomear, mover e apagar; anexo fora do drive", async () => {
    const { owner, ws, base } = await setup();
    const browser = await openBrowserSocket(owner, ws.id);
    const res = await upload(owner.cookie!, base, { folder: "Relatórios" }, "olá, mundo", "relatório.txt");
    expect(res.status).toBe(201);
    const file = (await res.json()) as FileDTO;
    expect(file).toMatchObject({ name: "relatório.txt", mime: "text/plain", size: 11, folder: "Relatórios", inDrive: true, author: { type: "user", id: owner.userId } });
    await browser.waitFor<Extract<ClientEvent, { type: "file.created" }>>((m) => m.type === "file.created" && m.file.id === file.id);
    const obj = await env.FILES.get(`ws/${ws.id}/${file.id}/relatório.txt`);
    expect(await obj?.text()).toBe("olá, mundo");

    const dl = await call(`${base}/files/${file.id}/content`, { headers: { Cookie: owner.cookie! } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Type")).toBe("text/plain");
    expect(dl.headers.get("Content-Disposition")).toContain("attachment");
    expect(dl.headers.get("Content-Disposition")).toContain("filename*=UTF-8''relat%C3%B3rio.txt");
    expect(await dl.text()).toBe("olá, mundo");

    const list = await owner.get<{ items: FileDTO[] }>(`${base}/files?folder=${encodeURIComponent("Relatórios")}`);
    expect(list.body.items.map((f) => f.id)).toEqual([file.id]);
    expect((await owner.get<{ items: FileDTO[] }>(`${base}/files?q=nada`)).body.items).toHaveLength(0);

    const renamed = await owner.patch<FileDTO>(`${base}/files/${file.id}`, { name: "final.txt", folder: "Arquivo" });
    expect(renamed.body).toMatchObject({ name: "final.txt", folder: "Arquivo" });

    // Anexo de mensagem: mesmo upload com inDrive=0, fora da listagem, mas baixável e anexável.
    const general = (await owner.get<{ items: { id: string; name: string }[] }>(`${base}/channels`)).body.items.find((c) => c.name === "general")!;
    const att = (await (await upload(owner.cookie!, base, { inDrive: "0", channelId: general.id }, "anexo")).json()) as FileDTO;
    expect(att.inDrive).toBe(false);
    expect((await owner.get<{ items: FileDTO[] }>(`${base}/files`)).body.items.map((f) => f.id)).toEqual([file.id]);
    const msg = await owner.post<{ attachments: { fileId: string }[] }>(`${base}/channels/${general.id}/messages`, { body: "segue", attachmentIds: [att.id] });
    expect(msg.body.attachments[0]!.fileId).toBe(att.id);

    // Outra pessoa (membro) não pode renomear nem apagar.
    const zeca = await signup("Zeca");
    const inv = await owner.post<{ code: string }>(`${base}/invites`, {});
    await zeca.post(`/api/invites/${inv.body.code}/accept`);
    expect((await zeca.del(`${base}/files/${file.id}`)).status).toBe(403);
    expect((await owner.del(`${base}/files/${file.id}`)).status).toBe(204);
    expect(await env.FILES.get(`ws/${ws.id}/${file.id}/relatório.txt`)).toBeNull();
    browser.close();
  });

  it("recusa arquivo acima de 25 MB e arquivo de canal privado fica invisível para quem não é membro", async () => {
    const { owner, ws, base } = await setup();
    const big = await call(`${base}/files`, {
      method: "POST",
      headers: { Cookie: owner.cookie!, "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(26 * 1024 * 1024) },
      body: "--x--",
    });
    expect(big.status).toBe(413);

    const priv = await owner.post<{ id: string }>(`${base}/channels`, { name: uniq("segredo"), isPrivate: true });
    const file = (await (await upload(owner.cookie!, base, { channelId: priv.body.id }, "confidencial")).json()) as FileDTO;
    const zeca = await signup("Zeca");
    const inv = await owner.post<{ code: string }>(`${base}/invites`, {});
    await zeca.post(`/api/invites/${inv.body.code}/accept`);
    expect((await zeca.get<{ items: FileDTO[] }>(`${base}/files`)).body.items.map((f) => f.id)).not.toContain(file.id);
    expect((await zeca.get(`${base}/files/${file.id}/content`)).status).toBe(404);
    await eventually(async () => (await owner.get<{ items: FileDTO[] }>(`${base}/files`)).body.items.some((f) => f.id === file.id));
  });
});
