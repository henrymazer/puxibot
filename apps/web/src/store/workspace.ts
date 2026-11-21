/**
 * Estado do workspace aberto. Dados vêm do `bootstrap` e são mantidos atualizados
 * pelos eventos do WebSocket (ver realtime/reducer.ts, o único lugar que trata `ClientEvent`).
 */
import { create } from "zustand";
import type {
  ActorRef,
  AgentDTO,
  ChannelDTO,
  ClientEvent,
  MessageDTO,
  NotificationDTO,
} from "@puxibot/shared";
import { api, errorMessage, socketFactory } from "../api";
import type { SendMessageInput } from "../api/client";
import { RealtimeConnection, type ConnectionStatus } from "../realtime/connection";
import {
  applyBootstrap,
  applyEvent,
  byId,
  emptyData,
  isJobActive,
  mergeMessages,
  type DataState,
} from "../realtime/reducer";

export const PAGE_SIZE = 50;

interface WorkspaceStore extends DataState {
  wsId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  connection: ConnectionStatus;
  notificationsLoaded: boolean;

  load: (wsId: string) => Promise<void>;
  /** Reconecta o tempo real depois de um fechamento 4008 (conexões demais). */
  reconnect: () => void;
  dispose: () => void;
  resync: () => Promise<void>;
  dispatch: (event: ClientEvent) => void;

  setActiveChannel: (channelId: string | null) => void;
  loadChannel: (channelId: string, force?: boolean) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  loadThread: (channelId: string, rootId: string) => Promise<void>;
  loadChannelJobs: (channelId: string) => Promise<void>;
  loadTasks: () => Promise<void>;
  loadFiles: () => Promise<void>;

  sendMessage: (channelId: string, input: SendMessageInput) => Promise<MessageDTO>;
  editMessage: (id: string, body: string) => Promise<void>;
  deleteMessage: (msg: MessageDTO) => Promise<void>;
  togglePin: (msg: MessageDTO) => Promise<void>;
  toggleReaction: (msg: MessageDTO, emoji: string) => Promise<void>;
  rate: (msg: MessageDTO, value: "up" | "down") => Promise<void>;
  notifyTyping: (channelId: string) => void;

  upsertChannel: (c: ChannelDTO) => void;
  upsertAgent: (a: AgentDTO) => void;
  openDm: (actor: ActorRef) => Promise<ChannelDTO>;

  loadNotifications: () => Promise<void>;
  markNotificationsRead: (ids?: string[]) => Promise<void>;
}

let connection: RealtimeConnection | null = null;
let lastTypingSent: Record<string, number> = {};

export const RATING_UP = "👍";
export const RATING_DOWN = "👎";

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  ...emptyData(),
  wsId: null,
  status: "idle",
  error: null,
  connection: "connecting",
  notificationsLoaded: false,

  async load(wsId) {
    if (get().wsId === wsId && get().status !== "error") return;
    get().dispose();
    set({ ...emptyData(), wsId, status: "loading", error: null, notificationsLoaded: false });
    try {
      const b = await api.bootstrap(wsId);
      if (get().wsId !== wsId) return;
      set((s) => ({ ...applyBootstrap(s, b), status: "ready" }));
    } catch (err) {
      if (get().wsId === wsId) set({ status: "error", error: errorMessage(err) });
      return;
    }
    connection = new RealtimeConnection({
      url: api.realtimeUrl(wsId),
      createSocket: socketFactory,
      onEvent: (e) => get().dispatch(e),
      onStatus: (c) => set({ connection: c }),
      onReconnect: () => void get().resync(),
    });
    connection.start();
  },

  reconnect() {
    connection?.reconnect();
  },

  dispose() {
    connection?.stop();
    connection = null;
    lastTypingSent = {};
  },

  async resync() {
    const { wsId, activeChannelId } = get();
    if (!wsId) return;
    try {
      const b = await api.bootstrap(wsId);
      set((s) => applyBootstrap(s, b));
      // As listas de outros canais ficam desatualizadas: recarregam quando forem abertas.
      set((s) => ({
        messages: activeChannelId && s.messages[activeChannelId] ? { [activeChannelId]: s.messages[activeChannelId]! } : {},
        threads: {},
      }));
      if (activeChannelId) {
        await Promise.all([get().loadChannel(activeChannelId, true), get().loadChannelJobs(activeChannelId)]);
      }
      if (get().notificationsLoaded) await get().loadNotifications();
      if (get().tasksLoaded) await get().loadTasks();
      if (get().filesLoaded) await get().loadFiles();
      // Telas da wiki recarregam ao ver o contador mudar.
      set((s) => ({ wikiVersion: s.wikiVersion + 1 }));
    } catch {
      /* a próxima reconexão tenta de novo */
    }
  },

  dispatch(event) {
    set((s) => applyEvent(s, event, Date.now()));
  },

  setActiveChannel(channelId) {
    set((s) => {
      if (!channelId) return { activeChannelId: null };
      const ch = s.channels[channelId];
      return {
        activeChannelId: channelId,
        channels: ch && ch.unread ? { ...s.channels, [channelId]: { ...ch, unread: 0 } } : s.channels,
      };
    });
    const ws = get().wsId;
    if (channelId && ws) {
      connection?.send({ type: "read", channelId });
      api.markRead(ws, channelId).catch(() => undefined);
    }
  },

  async loadChannel(channelId, force = false) {
    const ws = get().wsId;
    if (!ws) return;
    const existing = get().messages[channelId];
    if (existing?.loaded && !force) return;
    const items = await api.listMessages(ws, channelId, { limit: PAGE_SIZE });
    const top = items.filter((m) => !m.threadRootId);
    set((s) => ({
      messages: {
        ...s.messages,
        [channelId]: {
          items: force && existing ? mergeMessages(existing.items, top) : top,
          hasMore: items.length >= PAGE_SIZE,
          loaded: true,
        },
      },
    }));
  },

  async loadOlder(channelId) {
    const ws = get().wsId;
    const list = get().messages[channelId];
    if (!ws || !list || !list.hasMore) return;
    const oldest = list.items[0];
    const items = await api.listMessages(ws, channelId, { limit: PAGE_SIZE, before: oldest?.createdAt });
    const top = items.filter((m) => !m.threadRootId);
    set((s) => {
      const cur = s.messages[channelId] ?? { items: [], hasMore: true, loaded: true };
      return {
        messages: {
          ...s.messages,
          [channelId]: { ...cur, items: mergeMessages(cur.items, top), hasMore: items.length >= PAGE_SIZE },
        },
      };
    });
  },

  async loadThread(channelId, rootId) {
    const ws = get().wsId;
    if (!ws) return;
    const items = await api.listMessages(ws, channelId, { threadRootId: rootId, limit: 100 });
    // O hub inclui a raiz na lista; ela fica à parte e as respostas na thread.
    const rootFromList = items.find((m) => m.id === rootId);
    const replies = items.filter((m) => m.id !== rootId);
    set((s) => ({
      threads: { ...s.threads, [rootId]: { items: mergeMessages([], replies), hasMore: false, loaded: true } },
      threadRoots: rootFromList ? { ...s.threadRoots, [rootId]: rootFromList } : s.threadRoots,
    }));
    // Thread aberta pela busca: a raiz pode não estar entre as mensagens carregadas do canal.
    const inChannel = get().messages[channelId]?.items.some((m) => m.id === rootId);
    if (!inChannel && !get().threadRoots[rootId]) {
      const root = await api.getMessage(ws, rootId);
      if (root && root.id) set((s) => ({ threadRoots: { ...s.threadRoots, [rootId]: root } }));
    }
  },

  async loadTasks() {
    const ws = get().wsId;
    if (!ws) return;
    const list = await api.listTasks(ws);
    if (get().wsId !== ws) return;
    set({ tasks: byId(list, (t) => t.id), tasksLoaded: true });
  },

  async loadFiles() {
    const ws = get().wsId;
    if (!ws) return;
    const list = await api.listFiles(ws);
    if (get().wsId !== ws) return;
    set({ files: byId(list, (f) => f.id), filesLoaded: true });
  },

  async loadChannelJobs(channelId) {
    const ws = get().wsId;
    if (!ws) return;
    try {
      const jobs = await api.listJobs(ws, { channelId });
      const relevant = jobs.filter((j) => j.channelId === channelId && (isJobActive(j) || j.status === "failed"));
      // Só erros recentes (última hora) continuam visíveis ao reabrir.
      const recent = relevant.filter((j) => j.status !== "failed" || Date.now() - (j.finishedAt ?? j.createdAt) < 3600_000);
      set((s) => ({ jobs: { ...s.jobs, ...byId(recent, (j) => j.id) } }));
    } catch {
      /* sem a lista, os eventos ainda mostram os jobs novos */
    }
  },

  async sendMessage(channelId, input) {
    const ws = get().wsId!;
    const msg = await api.sendMessage(ws, channelId, input);
    set((s) => applyEvent(s, { type: "message.created", message: msg }, Date.now()));
    lastTypingSent[channelId] = 0;
    return msg;
  },

  async editMessage(id, body) {
    const msg = await api.editMessage(get().wsId!, id, body);
    if (msg && msg.id) set((s) => applyEvent(s, { type: "message.updated", message: msg }, Date.now()));
  },

  async deleteMessage(msg) {
    await api.deleteMessage(get().wsId!, msg.id);
    set((s) => applyEvent(s, { type: "message.deleted", channelId: msg.channelId, messageId: msg.id }, Date.now()));
  },

  async togglePin(msg) {
    const updated = await api.setPinned(get().wsId!, msg.id, !msg.pinned);
    const next = updated && updated.id ? updated : { ...msg, pinned: !msg.pinned };
    set((s) => applyEvent(s, { type: "message.updated", message: next }, Date.now()));
  },

  async toggleReaction(msg, emoji) {
    const ws = get().wsId!;
    const me = get().myUserId!;
    const has = msg.reactions.some((r) => r.emoji === emoji && r.userIds.includes(me));
    const optimistic = { ...msg, reactions: toggleReactionLocal(msg.reactions, emoji, me, !has) };
    set((s) => applyEvent(s, { type: "message.updated", message: optimistic }, Date.now()));
    try {
      if (has) await api.removeReaction(ws, msg.id, emoji);
      else await api.addReaction(ws, msg.id, emoji);
    } catch (err) {
      set((s) => applyEvent(s, { type: "message.updated", message: msg }, Date.now()));
      throw err;
    }
  },

  /** Avaliação de resposta de agente: reações 👍/👎 mutuamente exclusivas (ver tabela `reactions`). */
  async rate(msg, value) {
    const me = get().myUserId!;
    const emoji = value === "up" ? RATING_UP : RATING_DOWN;
    const other = value === "up" ? RATING_DOWN : RATING_UP;
    if (msg.reactions.some((r) => r.emoji === other && r.userIds.includes(me))) {
      await get().toggleReaction(msg, other);
      msg = findMessage(get(), msg) ?? msg;
    }
    await get().toggleReaction(msg, emoji);
  },

  notifyTyping(channelId) {
    const now = Date.now();
    if (now - (lastTypingSent[channelId] ?? 0) < 3000) return;
    lastTypingSent[channelId] = now;
    connection?.send({ type: "typing", channelId });
  },

  upsertChannel(c) {
    set((s) => applyEvent(s, { type: "channel.upserted", channel: c }, Date.now()));
  },
  upsertAgent(a) {
    set((s) => applyEvent(s, { type: "agent.upserted", agent: a }, Date.now()));
  },
  async openDm(actor) {
    const ch = await api.openDm(get().wsId!, actor);
    get().upsertChannel(ch);
    return ch;
  },

  async loadNotifications() {
    const items = await api.listNotifications(get().wsId!);
    set({
      notifications: items.sort((a, b) => b.createdAt - a.createdAt),
      notificationsLoaded: true,
      unreadNotifications: items.filter((n) => !n.read).length,
    });
  },
  async markNotificationsRead(ids) {
    await api.markNotificationsRead(get().wsId!, ids);
    set((s) => {
      const target = ids ? new Set(ids) : null;
      const notifications: NotificationDTO[] = s.notifications.map((n) =>
        !target || target.has(n.id) ? { ...n, read: true } : n,
      );
      return { notifications, unreadNotifications: notifications.filter((n) => !n.read).length };
    });
  },
}));

export function toggleReactionLocal(
  reactions: MessageDTO["reactions"],
  emoji: string,
  userId: string,
  add: boolean,
): MessageDTO["reactions"] {
  const out = reactions.map((r) => ({ ...r, userIds: [...r.userIds] }));
  const r = out.find((x) => x.emoji === emoji);
  if (add) {
    if (r) {
      if (!r.userIds.includes(userId)) r.userIds.push(userId);
    } else out.push({ emoji, userIds: [userId] });
  } else if (r) {
    r.userIds = r.userIds.filter((u) => u !== userId);
  }
  return out.filter((x) => x.userIds.length > 0);
}

function findMessage(s: DataState, msg: MessageDTO): MessageDTO | undefined {
  const list = msg.threadRootId ? s.threads[msg.threadRootId] : s.messages[msg.channelId];
  return list?.items.find((m) => m.id === msg.id);
}
