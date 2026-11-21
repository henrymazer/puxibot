import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiClientError, errorMessage } from "./client";

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return { fn, calls };
}

describe("ApiClient", () => {
  it("envia JSON com cookie e desembrulha { user }", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { user: { id: "u1", email: "a@b.c", name: "A", avatarColor: null } } }));
    const api = new ApiClient({ fetch: fn });
    const user = await api.login("a@b.c", "segredo123");
    expect(user.id).toBe("u1");
    expect(calls[0]!.url).toBe("/api/auth/login");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ email: "a@b.c", password: "segredo123" });
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("desembrulha listas { items } e monta a query", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { items: [{ id: "m1" }] } }));
    const api = new ApiClient({ fetch: fn });
    const list = await api.listMessages("w 1", "c1", { before: 123, limit: 50, pinned: true });
    expect(list).toEqual([{ id: "m1" }]);
    expect(calls[0]!.url).toBe("/api/workspaces/w%201/channels/c1/messages?before=123&limit=50&pinned=1");
  });

  it("aceita DTO cru ou embrulhado", async () => {
    const raw = new ApiClient({ fetch: fakeFetch(() => ({ status: 201, body: { id: "a1", handle: "x" } })).fn });
    expect((await raw.createAgent("w", { handle: "x", name: "X" })).id).toBe("a1");
    const wrapped = new ApiClient({ fetch: fakeFetch(() => ({ body: { agent: { id: "a2" } } })).fn });
    expect((await wrapped.getAgent("w", "a2")).id).toBe("a2");
  });

  it("transforma ApiError em ApiClientError com a mensagem do servidor", async () => {
    const api = new ApiClient({ fetch: fakeFetch(() => ({ status: 403, body: { error: { code: "forbidden", message: "Só admins mudam." } } })).fn });
    const err = await api.updateWorkspace("w", { name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("forbidden");
    expect(errorMessage(err)).toBe("Só admins mudam.");
  });

  it("usa mensagem padrão quando o corpo não é ApiError e trata 204", async () => {
    const api = new ApiClient({ fetch: fakeFetch((url) => (url.includes("logout") ? { status: 204 } : { status: 502 })).fn });
    await expect(api.logout()).resolves.toBeUndefined();
    const err = await api.listAgents("w").catch((e) => e);
    expect(err.message).toMatch(/servidor/);
  });

  it("chama onUnauthorized em 401 fora de /auth", async () => {
    const api = new ApiClient({ fetch: fakeFetch(() => ({ status: 401, body: { error: { code: "unauthorized", message: "Entre." } } })).fn });
    const spy = vi.fn();
    api.onUnauthorized = spy;
    await api.me().catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    await api.login("a@b.c", "x").catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("envia arquivo como multipart sem Content-Type manual", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 201, body: { id: "f1", name: "a.txt" } }));
    const api = new ApiClient({ fetch: fn });
    const f = await api.uploadFile("w", new File(["oi"], "a.txt", { type: "text/plain" }), { channelId: "c1" });
    expect(f.id).toBe("f1");
    const body = calls[0]!.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("channelId")).toBe("c1");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("remove reação com DELETE e corpo { emoji }", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 204 }));
    await new ApiClient({ fetch: fn }).removeReaction("w", "m1", "👍");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ emoji: "👍" });
  });

  it("monta a URL do WebSocket a partir da base", () => {
    expect(new ApiClient({ baseUrl: "https://hub.exemplo.com" }).realtimeUrl("w1")).toBe("wss://hub.exemplo.com/api/workspaces/w1/realtime");
    expect(new ApiClient({ baseUrl: "http://localhost:5173" }).realtimeUrl("w1")).toBe("ws://localhost:5173/api/workspaces/w1/realtime");
  });

  it("mensagem amigável para falha de rede", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/conexão/);
  });
});

describe("erros novos da API", () => {
  function failing(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new ApiClient({ fetch: async () => new Response(JSON.stringify(body), { status, headers }) });
  }

  it("429 com Retry-After diz quanto esperar, em minutos", async () => {
    const api = failing(429, { error: { code: "rate_limited", message: "Muitas tentativas." } }, { "Retry-After": "600" });
    const err = (await api.login("a@b.c", "x").catch((e) => e)) as ApiClientError;
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(600);
    expect(err.message).toBe("Muitas tentativas. Tente de novo em 10 min.");
  });

  it("429 sem Retry-After usa a mensagem do hub", async () => {
    const api = failing(429, { error: { code: "rate_limited", message: "Espere um pouco." } });
    const err = (await api.signup({ email: "a@b.c", name: "A", password: "x" }).catch((e) => e)) as ApiClientError;
    expect(err.message).toBe("Espere um pouco.");
  });

  it("arredonda a espera para cima e nunca mostra menos de 1 min", async () => {
    const { formatWait, parseRetryAfter } = await import("./client");
    expect(formatWait(5)).toBe("1 min");
    expect(formatWait(61)).toBe("2 min");
    expect(formatWait(3600)).toBe("60 min");
    expect(formatWait(3 * 3600)).toBe("3 h");
    expect(parseRetryAfter("abc")).toBeNull();
    expect(parseRetryAfter(new Date(10_000 + 120_000).toUTCString(), 10_000)).toBe(120);
  });

  it("csrf_origin e body_too_large ganham textos que dizem o que fazer", async () => {
    const csrf = (await failing(403, { error: { code: "csrf_origin", message: "Requisição recusada" } }).logout().catch((e) => e)) as ApiClientError;
    expect(csrf.code).toBe("csrf_origin");
    expect(csrf.message).toMatch(/recarregue a página/);
    const big = (await failing(413, { error: { code: "body_too_large", message: "grande" } }).logout().catch((e) => e)) as ApiClientError;
    expect(big.message).toMatch(/grande demais/);
  });

  it("mantém a mensagem do hub em workspace_limit, invalid_channel e assistant_owner_only", async () => {
    for (const [status, code, message] of [
      [429, "workspace_limit", "Você já criou 20 workspaces, o limite por pessoa."],
      [400, "invalid_channel", "Rotinas de agente não podem publicar num canal só de humanos."],
      [403, "assistant_owner_only", "O assistente pessoal só é configurado pela pessoa dona dele."],
    ] as const) {
      const err = (await failing(status, { error: { code, message } }).logout().catch((e) => e)) as ApiClientError;
      expect(err.message).toBe(message);
    }
  });
});
