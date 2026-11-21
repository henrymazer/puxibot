import { describe, expect, it } from "vitest";
import type { ChannelDTO, MessageDTO, UserDTO, WorkspaceDTO } from "@puxibot/shared";
import { createExecutionContext, env } from "cloudflare:test";
import { buildApp } from "../src/app";
import { BASE, bootstrap, call, Client, createWorkspace, general, signup, uniq } from "./helpers";

describe("cadastro fechado (padrão, sem OPEN_SIGNUP)", () => {
  const app = buildApp();
  const closed = (path: string, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    return app.fetch(new Request(BASE + path, init), { ...env, OPEN_SIGNUP: "" }, ctx);
  };
  const post = (path: string, body: unknown) =>
    closed(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("com contas existentes, recusa quem não tem convite e aceita quem tem", async () => {
    const owner = await signup("Dona");
    const ws = await createWorkspace(owner);
    const status = (await (await closed("/api/auth/signup-status")).json()) as { open: boolean; firstAccount: boolean };
    expect(status).toEqual({ open: false, firstAccount: false });

    const denied = await post("/api/auth/signup", { email: `${uniq("x")}@exemplo.com`, name: "Estranho", password: "senha-forte-123" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("signup_closed");

    // E-mail já cadastrado recebe a mesma resposta: instalação fechada não revela quem tem conta.
    const me = await owner.get<{ user: UserDTO }>("/api/me");
    const taken = await post("/api/auth/signup", { email: me.body.user.email, name: "Estranho", password: "senha-forte-123" });
    expect(taken.status).toBe(403);

    const invite = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    expect(invite.status).toBe(201);
    const ok = await post("/api/auth/signup", { email: `${uniq("c")}@exemplo.com`, name: "Convidada", password: "senha-forte-123", inviteCode: invite.body.code });
    expect(ok.status).toBe(201);
  });
});

describe("cadastro com convite de uso único", () => {
  it("cadastros simultâneos com o mesmo convite criam uma conta só; os outros recebem 410 sem conta", async () => {
    const owner = await signup("Dona Corrida");
    const ws = await createWorkspace(owner);
    const invite = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, { maxUses: 1 });
    expect(invite.status).toBe(201);
    const N = 5;
    // Força a pior intercalação: cada "INSERT INTO users" espera até os N pedidos chegarem
    // nele (ou 400 ms). Com a validação antes e o consumo depois, todos chegariam e N contas
    // seriam criadas; com o consumo atômico antes, só um chega.
    let waiting = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const timer = setTimeout(() => open(), 400);
    const pass = async () => {
      if (++waiting >= N) open();
      await gate;
    };
    const gatedStmt = (st: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(st, {
        get(t, p) {
          if (p === "bind") return (...a: unknown[]) => gatedStmt(t.bind(...a));
          if (p === "run" || p === "first" || p === "all") return async (...a: unknown[]) => (await pass(), (t[p] as (...x: unknown[]) => unknown)(...a));
          const v = Reflect.get(t, p) as unknown;
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
        },
      });
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare") return (sql: string) => (/^INSERT INTO users/.test(sql) ? gatedStmt(t.prepare(sql)) : t.prepare(sql));
        const v = Reflect.get(t, p) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const app = buildApp();
    const emails = Array.from({ length: N }, () => `${uniq("corrida")}@exemplo.com`);
    const results = await Promise.all(
      emails.map((email) =>
        app.fetch(
          new Request(BASE + "/api/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, name: "Concorrente", password: "senha-forte-123", inviteCode: invite.body.code }),
          }),
          { ...env, DB },
          createExecutionContext(),
        ),
      ),
    );
    clearTimeout(timer);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410, 410, 410, 410]);
    const placeholders = emails.map(() => "?").join(",");
    const users = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE email IN (${placeholders})`)
      .bind(...emails)
      .first<{ n: number }>();
    expect(users?.n).toBe(1);
    const row = await env.DB.prepare("SELECT uses FROM invites WHERE id = ?").bind(invite.body.code).first<{ uses: number }>();
    expect(row?.uses).toBe(1);
  });

  it("convite usado não cria conta (410)", async () => {
    const owner = await signup("Dona Usado");
    const ws = await createWorkspace(owner);
    const invite = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    expect((await signup("Primeira", invite.body.code)).userId).toBeTruthy();
    const email = `${uniq("tarde")}@exemplo.com`;
    const late = await new Client().post("/api/auth/signup", { email, name: "Atrasada", password: "senha-forte-123", inviteCode: invite.body.code });
    expect(late.status).toBe(410);
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()).toBeNull();
  });
});

describe("auth e sessão", () => {
  it("cadastra, mantém sessão, faz logout e login", async () => {
    const c = new Client();
    const email = `${uniq("ana")}@exemplo.com`;
    const created = await c.post<{ user: UserDTO }>("/api/auth/signup", { email, name: "Ana", password: "senha-forte-123" });
    expect(created.status).toBe(201);
    expect(created.body.user.email).toBe(email);
    expect(c.cookie).toMatch(/^tb_session=/);

    const me = await c.get<{ user: UserDTO; workspaces: WorkspaceDTO[] }>("/api/me");
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(created.body.user.id);
    expect(me.body.workspaces).toEqual([]);

    const dup = await new Client().post("/api/auth/signup", { email, name: "Outra", password: "senha-forte-123" });
    expect(dup.status).toBe(409);

    expect((await c.post("/api/auth/logout")).status).toBe(204);
    const anon = await new Client().get<{ error: { code: string; message: string } }>("/api/me");
    expect(anon.status).toBe(401);
    expect(anon.body.error.message).toMatch(/login/i);

    const wrong = await new Client().post<{ error: { message: string } }>("/api/auth/login", { email, password: "errada-123" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe("E-mail ou senha incorretos.");

    const again = new Client();
    const login = await again.post<{ user: UserDTO }>("/api/auth/login", { email, password: "senha-forte-123" });
    expect(login.status).toBe(200);
    expect((await again.get("/api/me")).status).toBe(200);
  });

  it("valida entrada com mensagem em português", async () => {
    const res = await new Client().post<{ error: { code: string; message: string } }>("/api/auth/signup", {
      email: "nao-e-email",
      name: "X",
      password: "123",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(res.body.error.message).toMatch(/Dados inválidos/);
  });

  it("responde 404 JSON para rota inexistente da API", async () => {
    const res = await call("/api/nao-existe");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});

describe("workspace, convite e isolamento", () => {
  it("cria workspace com general e assistente pessoal; bootstrap completo", async () => {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner, "Agência");
    expect(ws.role).toBe("owner");
    const b = await bootstrap(owner, ws.id);
    expect(b.me.role).toBe("owner");
    expect(b.channels.some((c) => c.name === "general")).toBe(true);
    const assistant = b.agents.find((a) => a.isAssistant)!;
    expect(assistant.handle).toBe("assistente-renato");
    expect(assistant.accessMode).toBe("owner");
    expect(assistant.toolPerms.messages).toBe("write");
    // DM com o assistente criada
    expect(b.channels.some((c) => c.kind === "dm" && c.members.some((m) => m.id === assistant.id))).toBe(true);
    expect(b.unreadNotifications).toBe(0);

    const got = await owner.get<{ workspace: WorkspaceDTO }>(`/api/workspaces/${ws.id}`);
    expect(got.status).toBe(200);
    expect(got.body.workspace.name).toBe("Agência");
    const patched = await owner.patch<{ workspace: WorkspaceDTO }>(`/api/workspaces/${ws.id}`, { routerEnabled: true });
    expect(patched.body.workspace.routerEnabled).toBe(true);
  });

  it("convite: link, entrada, assistente com sufixo e workspace na lista", async () => {
    const owner = await signup("Renato Lima");
    const ws = await createWorkspace(owner);
    const inv = await owner.post<{ code: string; url: string }>(`/api/workspaces/${ws.id}/invites`, { maxUses: 2 });
    expect(inv.status).toBe(201);
    expect(inv.body.url).toContain(`/convite/${inv.body.code}`);

    const info = await call(`/api/invites/${inv.body.code}`);
    expect(await info.json()).toEqual({ workspaceName: "Time", valid: true });

    // Entrada pelo cadastro com inviteCode
    const bia = await signup("Renato Prado", inv.body.code);
    const me = await bia.get<{ workspaces: WorkspaceDTO[] }>("/api/me");
    expect(me.body.workspaces.map((w) => w.id)).toContain(ws.id);
    expect(me.body.workspaces[0]!.role).toBe("member");

    // Entrada pelo accept
    const carl = await signup("Carla");
    const acc = await carl.post<{ workspace: WorkspaceDTO }>(`/api/invites/${inv.body.code}/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body.workspace.id).toBe(ws.id);

    // Esgotado
    const dan = await signup("Dan");
    expect((await dan.post(`/api/invites/${inv.body.code}/accept`)).status).toBe(410);

    const b = await bootstrap(owner, ws.id);
    expect(b.members).toHaveLength(3);
    const handles = b.agents.filter((a) => a.isAssistant).map((a) => a.handle).sort();
    expect(handles).toEqual(["assistente-carla", "assistente-renato", "assistente-renato-2"]);
    // Membro novo entra no general
    const gen = b.channels.find((c) => c.name === "general")!;
    expect(gen.members.some((m) => m.id === carl.userId)).toBe(true);

    // Membro comum não convida
    expect((await carl.post(`/api/workspaces/${ws.id}/invites`, {})).status).toBe(403);
  });

  it("membro do workspace A não lê nada do workspace B", async () => {
    const a = await signup("Alice");
    const b = await signup("Bruno");
    const wsA = await createWorkspace(a, "A");
    const wsB = await createWorkspace(b, "B");
    const genB = await general(b, wsB.id);
    const sent = await b.post<MessageDTO>(`/api/workspaces/${wsB.id}/channels/${genB.id}/messages`, { body: "segredo de B" });
    expect(sent.status).toBe(201);

    for (const path of [
      `/api/workspaces/${wsB.id}`,
      `/api/workspaces/${wsB.id}/bootstrap`,
      `/api/workspaces/${wsB.id}/channels`,
      `/api/workspaces/${wsB.id}/channels/${genB.id}/messages`,
      `/api/workspaces/${wsB.id}/agents`,
    ]) {
      const res = await a.get(path);
      expect(res.status, path).toBe(404);
    }
    // Usar o id do canal de B dentro do workspace A também não funciona.
    expect((await a.get(`/api/workspaces/${wsA.id}/channels/${genB.id}/messages`)).status).toBe(404);
    expect((await a.post(`/api/workspaces/${wsA.id}/channels/${genB.id}/messages`, { body: "oi" })).status).toBe(404);
    expect((await a.patch(`/api/workspaces/${wsA.id}/messages/${sent.body.id}`, { pinned: true })).status).toBe(404);

    // Token de A não vale em B
    const tok = await a.post<{ token: string }>(`/api/workspaces/${wsA.id}/tokens`, { name: "script" });
    const res = await call(`/api/workspaces/${wsB.id}/channels`, { headers: { Authorization: `Bearer ${tok.body.token}` } });
    expect(res.status).toBe(403);
    const ok = await call(`/api/workspaces/${wsA.id}/channels`, { headers: { Authorization: `Bearer ${tok.body.token}` } });
    expect(ok.status).toBe(200);
    const list = (await ok.json()) as { items: ChannelDTO[] };
    expect(list.items.every((c) => c.id !== genB.id)).toBe(true);
  });

  it("pareamento de runner: start, approve e poll entrega o token uma vez", async () => {
    const owner = await signup("Rita");
    const ws = await createWorkspace(owner);
    const start = await new Client().post<{ pairCode: string; pollToken: string }>("/api/runner/pair/start", { name: "mac-da-rita" });
    expect(start.status).toBe(201);
    const pending = await new Client().post<{ status: string }>("/api/runner/pair/poll", { pollToken: start.body.pollToken });
    expect(pending.body.status).toBe("pending");
    const approve = await owner.post(`/api/workspaces/${ws.id}/runner/pair/approve`, { pairCode: start.body.pairCode });
    expect(approve.status).toBe(200);
    const done = await new Client().post<{ status: string; token: string; workspaceId: string; hubUrl: string }>(
      "/api/runner/pair/poll",
      { pollToken: start.body.pollToken },
    );
    expect(done.body.status).toBe("approved");
    expect(done.body.token).toMatch(/^tb_/);
    expect(done.body.workspaceId).toBe(ws.id);
    expect(done.body.hubUrl).toBe("http://localhost");
    expect((await new Client().post("/api/runner/pair/poll", { pollToken: start.body.pollToken })).status).toBe(410);
    // Token de runner não vale para a API REST
    const rest = await call(`/api/workspaces/${ws.id}/channels`, { headers: { Authorization: `Bearer ${done.body.token}` } });
    expect(rest.status).toBe(403);
  });
});
