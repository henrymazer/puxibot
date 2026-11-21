import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { userHandle, type ChannelDTO, type MyNotificationDTO, type TelegramLinkDTO } from "@puxibot/shared";
import { base64UrlToBytes } from "../src/lib/crypto";
import { deliverPush, vapidConfigured } from "../src/domain/push";
import { telegramText } from "../src/domain/telegram";
import { workerCtx } from "../src/domain/context";
import type { AppEnv } from "../src/env";
import { call, createWorkspace, eventually, signup } from "./helpers";

const realFetch = globalThis.fetch;

function captureFetch() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const responses = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://localhost")) return realFetch(input as Request, init);
    calls.push({ url, init });
    for (const [prefix, status] of responses) if (url.startsWith(prefix)) return new Response(null, { status });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 201 });
  });
  return { calls, responses };
}

afterEach(() => vi.restoreAllMocks());

async function verifyVapid(authorization: string, audience: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  expect(m).not.toBeNull();
  const [header, claims, sig] = m![1]!.split(".");
  expect(m![2]).toBe(env.VAPID_PUBLIC_KEY);
  expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(header!)))).toEqual({ typ: "JWT", alg: "ES256" });
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(claims!)));
  expect(payload.aud).toBe(audience);
  expect(payload.sub).toBe("mailto:testes@puxibot.local");
  expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
  expect(payload.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 3600);
  const key = await crypto.subtle.importKey("raw", base64UrlToBytes(m![2]!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlToBytes(sig!), new TextEncoder().encode(`${header}.${claims}`));
  expect(ok).toBe(true);
}

describe("Web Push sem conteúdo", () => {
  it("chave pública, inscrição, push com cabeçalho VAPID válido e sem corpo; 410 remove a inscrição", async () => {
    const fake = captureFetch();
    const owner = await signup("Renato Lima");
    const bob = await signup("Bob");
    const ws = await createWorkspace(owner);
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    await bob.post(`/api/invites/${inv.body.code}/accept`);

    const key = await call("/api/push/public-key");
    expect(await key.json()).toEqual({ key: env.VAPID_PUBLIC_KEY });
    const endpoint = `https://push.exemplo.com/send/${crypto.randomUUID()}`;
    const gone = `https://fcm.exemplo.net/send/${crypto.randomUUID()}`;
    for (const ep of [endpoint, gone]) {
      const sub = await bob.post("/api/push/subscriptions", { endpoint: ep, keys: { p256dh: "BPxx", auth: "yy" } });
      expect(sub.status).toBe(201);
    }
    fake.responses.set("https://fcm.exemplo.net", 410);

    // DM de pessoa para pessoa gera notificação `dm` para Bob.
    const dm = await owner.post<ChannelDTO>(`/api/workspaces/${ws.id}/dms`, { with: { type: "user", id: bob.userId } });
    await owner.post(`/api/workspaces/${ws.id}/channels/${dm.body.id}/messages`, { body: "conteúdo secreto da mensagem" });

    const push = await eventually(async () => fake.calls.find((c) => c.url === endpoint));
    expect(push.init?.method).toBe("POST");
    expect(push.init?.body ?? null).toBeNull();
    const headers = new Headers(push.init?.headers);
    expect(headers.get("TTL")).toBe("86400");
    expect(headers.get("Content-Length")).toBe("0");
    await verifyVapid(headers.get("Authorization")!, "https://push.exemplo.com");
    expect(JSON.stringify(fake.calls)).not.toContain("conteúdo secreto");

    await eventually(async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?").bind(gone).first<{ n: number }>();
      return row?.n === 0;
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first<{ n: number }>())?.n).toBe(1);

    // O service worker busca as notificações sem saber o workspace.
    const mine = await bob.get<{ items: MyNotificationDTO[] }>("/api/me/notifications?unread=1");
    expect(mine.body.items[0]).toMatchObject({ workspaceId: ws.id, kind: "dm", title: "Renato Lima mandou uma mensagem" });

    expect((await bob.del(`/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`)).status).toBe(204);
  });

  it("sem chaves VAPID fica desligado, sem erro", async () => {
    const fake = captureFetch();
    const off = { ...env, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" } as AppEnv;
    expect(vapidConfigured(off)).toBe(false);
    await deliverPush({ ...workerCtx(off, "x"), env: off }, "qualquer");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Telegram, só avisos", () => {
  it("link + webhook /start vinculam a conta; aviso leva só título e link", async () => {
    const fake = captureFetch();
    const owner = await signup("Renato Lima");
    const bob = await signup("Bob");
    const ws = await createWorkspace(owner);
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    await bob.post(`/api/invites/${inv.body.code}/accept`);

    const link = await bob.get<TelegramLinkDTO>("/api/telegram/link");
    expect(link.body).toMatchObject({ botUsername: "puxibot_teste_bot", linked: false });
    expect(link.body.linkCode).toMatch(/^[A-Z0-9]{12}$/);

    expect((await call("/api/telegram/webhook/errado", { method: "POST", body: "{}" })).status).toBe(404);
    const hook = await call("/api/telegram/webhook/segredo-do-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { chat: { id: 4242 }, text: `/start ${link.body.linkCode}` } }),
    });
    expect(hook.status).toBe(200);
    expect((await bob.get<TelegramLinkDTO>("/api/telegram/link")).body.linked).toBe(true);
    const reply = fake.calls.find((c) => c.url.endsWith("/sendMessage"))!;
    expect(reply.url).toBe("https://api.telegram.org/bot123:test-token/sendMessage");
    expect(JSON.parse(String(reply.init?.body))).toMatchObject({ chat_id: 4242 });

    fake.calls.length = 0;
    const ch = await owner.post<ChannelDTO>(`/api/workspaces/${ws.id}/channels`, { name: `dev-${Date.now().toString(36)}` });
    const me = await bob.get<{ user: { email: string } }>("/api/me");
    await owner.post(`/api/workspaces/${ws.id}/channels/${ch.body.id}/messages`, { body: `@${userHandle(me.body.user)} olha isso aqui: senha123` });
    const sent = await eventually(async () => fake.calls.find((c) => c.url.endsWith("/sendMessage")));
    const text = JSON.parse(String(sent.init?.body)).text as string;
    expect(text).toBe(`Renato Lima mencionou você em #${ch.body.name}`);
    expect(text).not.toContain("senha123");

    expect(telegramText({ ...env, PUBLIC_URL: "https://time.exemplo.com" } as AppEnv, { title: "Marcos respondeu em #dev", link: "/w/1/c/2" })).toBe(
      "Marcos respondeu em #dev\nhttps://time.exemplo.com/w/1/c/2",
    );
    expect((await bob.del("/api/telegram/link")).status).toBe(204);
  });
});
