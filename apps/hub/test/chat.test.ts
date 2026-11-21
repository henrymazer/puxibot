import { describe, expect, it } from "vitest";
import type { ChannelDTO, ClientEvent, MessageDTO } from "@puxibot/shared";
import { createWorkspace, openBrowserSocket, signup } from "./helpers";

describe("canais e mensagens", () => {
  it("cria canal, envia mensagem, lista, reage, fixa, conta não lidas e entrega em tempo real", async () => {
    const owner = await signup("Olga");
    const ws = await createWorkspace(owner);
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    const bob = await signup("Bob", inv.body.code);

    const created = await owner.post<ChannelDTO>(`/api/workspaces/${ws.id}/channels`, {
      name: "Dev Time",
      section: "Tech",
      members: [{ type: "user", id: bob.userId }],
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("dev-time");
    expect(created.body.members).toHaveLength(2);

    const bobSock = await openBrowserSocket(bob, ws.id);
    const sent = await owner.post<MessageDTO>(`/api/workspaces/${ws.id}/channels/${created.body.id}/messages`, {
      body: "Olá @bob, tudo certo?",
    });
    expect(sent.status).toBe(201);
    expect(sent.body.author).toEqual({ type: "user", id: owner.userId });

    const ev = await bobSock.waitFor<Extract<ClientEvent, { type: "message.created" }>>(
      (m) => m.type === "message.created" && m.message.id === sent.body.id,
    );
    expect(ev.message.body).toBe("Olá @bob, tudo certo?");

    const list = await bob.get<{ items: ChannelDTO[] }>(`/api/workspaces/${ws.id}/channels`);
    expect(list.body.items.find((c) => c.id === created.body.id)!.unread).toBe(1);
    expect((await bob.post(`/api/workspaces/${ws.id}/channels/${created.body.id}/read`)).status).toBe(204);
    const list2 = await bob.get<{ items: ChannelDTO[] }>(`/api/workspaces/${ws.id}/channels`);
    expect(list2.body.items.find((c) => c.id === created.body.id)!.unread).toBe(0);

    const reacted = await bob.post<MessageDTO>(`/api/workspaces/${ws.id}/messages/${sent.body.id}/reactions`, { emoji: "👍" });
    expect(reacted.body.reactions).toEqual([{ emoji: "👍", userIds: [bob.userId] }]);
    const pinned = await bob.patch<MessageDTO>(`/api/workspaces/${ws.id}/messages/${sent.body.id}`, { pinned: true });
    expect(pinned.body.pinned).toBe(true);
    // Bob não edita o texto da mensagem da Olga
    expect((await bob.patch(`/api/workspaces/${ws.id}/messages/${sent.body.id}`, { body: "x" })).status).toBe(403);

    const reply = await bob.post<MessageDTO>(`/api/workspaces/${ws.id}/channels/${created.body.id}/messages`, {
      body: "Tudo!",
      threadRootId: sent.body.id,
    });
    expect(reply.status).toBe(201);
    const top = await owner.get<{ items: MessageDTO[] }>(`/api/workspaces/${ws.id}/channels/${created.body.id}/messages`);
    expect(top.body.items.map((m) => m.id)).toEqual([sent.body.id]);
    expect(top.body.items[0]!.replyCount).toBe(1);
    const thread = await owner.get<{ items: MessageDTO[] }>(
      `/api/workspaces/${ws.id}/channels/${created.body.id}/messages?threadRootId=${sent.body.id}`,
    );
    // Segunda leva: a raiz vem junto (primeiro item na página mais antiga).
    expect(thread.body.items.map((m) => m.id)).toEqual([sent.body.id, reply.body.id]);
    const pins = await owner.get<{ items: MessageDTO[] }>(`/api/workspaces/${ws.id}/channels/${created.body.id}/messages?pinned=1`);
    expect(pins.body.items.map((m) => m.id)).toEqual([sent.body.id]);

    expect((await owner.del(`/api/workspaces/${ws.id}/messages/${sent.body.id}`)).status).toBe(204);
    await bobSock.waitFor((m) => m.type === "message.deleted" && m.messageId === sent.body.id);
    bobSock.close();
  });

  it("canal privado: quem não é membro não vê nem recebe eventos", async () => {
    const owner = await signup("Paula");
    const ws = await createWorkspace(owner);
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    const outsider = await signup("Otto", inv.body.code);
    const sock = await openBrowserSocket(outsider, ws.id);

    const priv = await owner.post<ChannelDTO>(`/api/workspaces/${ws.id}/channels`, { name: "diretoria", isPrivate: true });
    const msg = await owner.post<MessageDTO>(`/api/workspaces/${ws.id}/channels/${priv.body.id}/messages`, { body: "confidencial" });
    expect(msg.status).toBe(201);

    const list = await outsider.get<{ items: ChannelDTO[] }>(`/api/workspaces/${ws.id}/channels`);
    expect(list.body.items.some((c) => c.id === priv.body.id)).toBe(false);
    expect((await outsider.get(`/api/workspaces/${ws.id}/channels/${priv.body.id}/messages`)).status).toBe(404);
    // Um evento público depois, para garantir que o privado não chegou antes dele.
    const gen = list.body.items.find((c) => c.name === "general")!;
    const pub = await owner.post<MessageDTO>(`/api/workspaces/${ws.id}/channels/${gen.id}/messages`, { body: "aberto" });
    await sock.waitFor((m) => m.type === "message.created" && m.message.id === pub.body.id);
    expect(sock.received.some((m) => m.type === "message.created" && m.message.id === msg.body.id)).toBe(false);
    expect(sock.received.some((m) => m.type === "channel.upserted" && m.channel.id === priv.body.id)).toBe(false);
    sock.close();
  });

  it("DM entre pessoas é única e notifica o destinatário", async () => {
    const owner = await signup("Lia");
    const ws = await createWorkspace(owner);
    const inv = await owner.post<{ code: string }>(`/api/workspaces/${ws.id}/invites`, {});
    const max = await signup("Max", inv.body.code);
    const dm1 = await owner.post<ChannelDTO>(`/api/workspaces/${ws.id}/dms`, { with: { type: "user", id: max.userId } });
    expect(dm1.status).toBe(201);
    const dm2 = await max.post<ChannelDTO>(`/api/workspaces/${ws.id}/dms`, { with: { type: "user", id: owner.userId } });
    expect(dm2.status).toBe(200);
    expect(dm2.body.id).toBe(dm1.body.id);
    await owner.post(`/api/workspaces/${ws.id}/channels/${dm1.body.id}/messages`, { body: "oi Max" });
    const notes = await max.get<{ items: { kind: string; title: string }[] }>(`/api/workspaces/${ws.id}/notifications`);
    expect(notes.body.items[0]).toMatchObject({ kind: "dm", title: "Lia mandou uma mensagem" });
    expect((await max.post(`/api/workspaces/${ws.id}/notifications/read`, {})).status).toBe(204);
    const after = await max.get<{ items: { read: boolean }[] }>(`/api/workspaces/${ws.id}/notifications`);
    expect(after.body.items.every((n) => n.read)).toBe(true);
  });
});
