import { describe, expect, it } from "vitest";
import { applyBootstrap, applyEvent, emptyData, mergeMessages, typingActors, upsertSorted, type DataState } from "./reducer";
import { bootstrap, channel, job, msg } from "../test/fixtures";

function ready(): DataState {
  const s = applyBootstrap(emptyData(), bootstrap());
  return { ...s, messages: { c1: { items: [msg({ id: "m1", createdAt: 100 })], hasMore: false, loaded: true } } };
}

describe("applyEvent", () => {
  it("adiciona mensagem nova no canal carregado e conta não lida em canal inativo", () => {
    let s = ready();
    s = applyEvent(s, { type: "message.created", message: msg({ id: "m2", createdAt: 200 }) }, 0);
    expect(s.messages.c1!.items.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.channels.c1!.unread).toBe(1);
    expect(s.channels.c1!.lastMessageAt).toBe(200);
  });

  it("não conta não lida no canal aberto nem para mensagens da própria pessoa", () => {
    let s: DataState = { ...ready(), activeChannelId: "c1" };
    s = applyEvent(s, { type: "message.created", message: msg({ id: "m2", createdAt: 200 }) }, 0);
    expect(s.channels.c1!.unread).toBe(0);
    s = { ...s, activeChannelId: null };
    s = applyEvent(s, { type: "message.created", message: msg({ id: "m3", author: { type: "user", id: "u1" }, createdAt: 300 }) }, 0);
    expect(s.channels.c1!.unread).toBe(0);
  });

  it("é idempotente para a mesma mensagem (eco do envio + evento)", () => {
    let s = ready();
    const m = msg({ id: "m2", createdAt: 200 });
    s = applyEvent(s, { type: "message.created", message: m }, 0);
    s = applyEvent(s, { type: "message.created", message: m }, 0);
    expect(s.messages.c1!.items).toHaveLength(2);
  });

  it("resposta em thread vai para a thread e incrementa replyCount da raiz", () => {
    let s = ready();
    s = { ...s, threads: { m1: { items: [], hasMore: false, loaded: true } } };
    s = applyEvent(s, { type: "message.created", message: msg({ id: "r1", threadRootId: "m1", createdAt: 150 }) }, 0);
    expect(s.threads.m1!.items.map((m) => m.id)).toEqual(["r1"]);
    expect(s.messages.c1!.items[0]!.replyCount).toBe(1);
    expect(s.messages.c1!.items).toHaveLength(1);
  });

  it("mensagem final do agente substitui o streaming do job", () => {
    let s = ready();
    s = applyEvent(s, { type: "job.updated", job: job({ id: "j1", status: "running" }) }, 0);
    s = applyEvent(s, { type: "job.stream", jobId: "j1", channelId: "c1", agentId: "a1", text: "Olá, par" }, 10);
    expect(s.streams.j1!.text).toBe("Olá, par");
    s = applyEvent(s, { type: "job.stream", jobId: "j1", channelId: "c1", agentId: "a1", text: "Olá, parceiro" }, 20);
    expect(s.streams.j1!.text).toBe("Olá, parceiro");
    s = applyEvent(s, { type: "message.created", message: msg({ id: "m9", author: { type: "agent", id: "a1" }, jobId: "j1", createdAt: 300 }) }, 30);
    expect(s.streams.j1).toBeUndefined();
  });

  it("job cancelado ou com erro descarta o streaming e ignora pedaços atrasados", () => {
    let s = ready();
    s = applyEvent(s, { type: "job.stream", jobId: "j1", channelId: "c1", agentId: "a1", text: "abc" }, 0);
    s = applyEvent(s, { type: "job.updated", job: job({ id: "j1", status: "failed", error: "x" }) }, 0);
    expect(s.streams.j1).toBeUndefined();
    s = applyEvent(s, { type: "job.stream", jobId: "j1", channelId: "c1", agentId: "a1", text: "abcd" }, 0);
    expect(s.streams.j1).toBeUndefined();
  });

  it("edição e remoção atualizam as listas", () => {
    let s = ready();
    s = applyEvent(s, { type: "message.updated", message: msg({ id: "m1", body: "editada", createdAt: 100 }) }, 0);
    expect(s.messages.c1!.items[0]!.body).toBe("editada");
    s = applyEvent(s, { type: "message.deleted", channelId: "c1", messageId: "m1" }, 0);
    expect(s.messages.c1!.items).toHaveLength(0);
  });

  it("presença atualiza o membro e o próprio usuário", () => {
    let s = ready();
    s = applyEvent(s, { type: "presence", userId: "u1", online: false, runnerOnline: true }, 0);
    expect(s.members.u1!.online).toBe(false);
    expect(s.me!.runnerOnline).toBe(true);
  });

  it("digitação expira e ignora a própria pessoa", () => {
    let s = ready();
    s = applyEvent(s, { type: "typing", channelId: "c1", actor: { type: "user", id: "u1" } }, 0);
    expect(s.typing.c1).toBeUndefined();
    s = applyEvent(s, { type: "typing", channelId: "c1", actor: { type: "user", id: "u2" } }, 1000);
    expect(typingActors(s, "c1", 2000)).toEqual(["user:u2"]);
    expect(typingActors(s, "c1", 99_999)).toEqual([]);
  });

  it("aprovação decidida sai da lista de pendentes", () => {
    let s = ready();
    const a = { id: "p1", agentId: "a1", jobId: null, kind: "action" as const, title: "t", details: null, approverUserId: "u1", status: "pending" as const, decidedBy: null, decidedAt: null, decisionNote: null, createdAt: 1 };
    s = applyEvent(s, { type: "approval.upserted", approval: a }, 0);
    expect(Object.keys(s.approvals)).toEqual(["p1"]);
    s = applyEvent(s, { type: "approval.upserted", approval: { ...a, status: "approved" } }, 0);
    expect(Object.keys(s.approvals)).toEqual([]);
  });

  it("notificação nova incrementa o contador uma única vez", () => {
    let s = ready();
    const n = { id: "n1", kind: "mention" as const, title: "t", body: null, link: null, read: false, createdAt: 1 };
    s = applyEvent(s, { type: "notification.created", notification: n }, 0);
    s = applyEvent(s, { type: "notification.created", notification: n }, 0);
    expect(s.unreadNotifications).toBe(1);
    expect(s.notifications).toHaveLength(1);
  });

  it("canal novo e canal apagado", () => {
    let s = ready();
    s = applyEvent(s, { type: "channel.upserted", channel: channel({ id: "c3" }) }, 0);
    expect(s.channels.c3).toBeDefined();
    s = applyEvent(s, { type: "channel.deleted", channelId: "c1" }, 0);
    expect(s.channels.c1).toBeUndefined();
    expect(s.messages.c1).toBeUndefined();
  });
});

describe("listas de mensagens", () => {
  it("upsertSorted insere fora de ordem na posição certa", () => {
    const list = [msg({ id: "a", createdAt: 1 }), msg({ id: "c", createdAt: 3 })];
    expect(upsertSorted(list, msg({ id: "b", createdAt: 2 })).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  it("mergeMessages junta páginas sem duplicar", () => {
    const a = [msg({ id: "b", createdAt: 2 }), msg({ id: "c", createdAt: 3 })];
    const b = [msg({ id: "a", createdAt: 1 }), msg({ id: "b", createdAt: 2, body: "novo" })];
    const out = mergeMessages(a, b);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(out[1]!.body).toBe("novo");
  });
});

describe("applyBootstrap", () => {
  it("preserva mensagens e streams ao ressincronizar", () => {
    let s = ready();
    s = applyEvent(s, { type: "job.stream", jobId: "j1", channelId: "c1", agentId: "a1", text: "x" }, 0);
    s = applyBootstrap(s, bootstrap({ channels: [channel({ id: "c1", unread: 4 })] }));
    expect(s.messages.c1!.items).toHaveLength(1);
    expect(s.streams.j1).toBeDefined();
    expect(s.channels.c2).toBeUndefined();
    expect(s.channels.c1!.unread).toBe(4);
  });
});
