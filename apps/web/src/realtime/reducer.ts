/**
 * Único lugar que traduz `ClientEvent` em mudanças de estado.
 * Função pura: (estado, evento, agora) -> novo estado. Testada em reducer.test.ts.
 */
import type {
  AgentDTO,
  ApprovalDTO,
  BootstrapDTO,
  ChannelDTO,
  ClientEvent,
  FileDTO,
  JobDTO,
  JobEventDTO,
  MemberDTO,
  MessageDTO,
  NotificationDTO,
  RunnerDTO,
  SectorDTO,
  TaskDTO,
  WorkspaceDTO,
} from "@puxibot/shared";

export interface MessageList {
  items: MessageDTO[];
  /** Ainda há mensagens mais antigas no servidor. */
  hasMore: boolean;
  loaded: boolean;
}

export interface StreamState {
  jobId: string;
  channelId: string | null;
  agentId: string;
  text: string;
  updatedAt: number;
}

export interface DataState {
  myUserId: string | null;
  activeChannelId: string | null;
  workspace: WorkspaceDTO | null;
  me: MemberDTO | null;
  members: Record<string, MemberDTO>;
  sectors: Record<string, SectorDTO>;
  agents: Record<string, AgentDTO>;
  channels: Record<string, ChannelDTO>;
  runners: Record<string, RunnerDTO>;
  approvals: Record<string, ApprovalDTO>;
  notifications: NotificationDTO[];
  unreadNotifications: number;
  /** Mensagens de nível superior por canal. */
  messages: Record<string, MessageList>;
  /** Respostas por mensagem raiz. */
  threads: Record<string, MessageList>;
  jobs: Record<string, JobDTO>;
  jobEvents: Record<string, JobEventDTO[]>;
  streams: Record<string, StreamState>;
  /** canal -> chave do ator ("user:id") -> expira em (ms). */
  typing: Record<string, Record<string, number>>;
  /** Raízes de thread buscadas à parte (ex.: thread aberta pela busca). */
  threadRoots: Record<string, MessageDTO>;
  tasks: Record<string, TaskDTO>;
  tasksLoaded: boolean;
  /** Arquivos do drive (só `inDrive`). */
  files: Record<string, FileDTO>;
  filesLoaded: boolean;
  /** Contador de mudanças da wiki: total e por página (`wiki.changed`). */
  wikiVersion: number;
  wikiPageVersions: Record<string, number>;
}

export const TYPING_TTL_MS = 6000;
const ACTIVE_JOB = new Set<JobDTO["status"]>(["awaiting_approval", "queued", "assigned", "running"]);
export const isJobActive = (j: JobDTO): boolean => ACTIVE_JOB.has(j.status);

export function emptyData(): DataState {
  return {
    myUserId: null,
    activeChannelId: null,
    workspace: null,
    me: null,
    members: {},
    sectors: {},
    agents: {},
    channels: {},
    runners: {},
    approvals: {},
    notifications: [],
    unreadNotifications: 0,
    messages: {},
    threads: {},
    jobs: {},
    jobEvents: {},
    streams: {},
    typing: {},
    threadRoots: {},
    tasks: {},
    tasksLoaded: false,
    files: {},
    filesLoaded: false,
    wikiVersion: 0,
    wikiPageVersions: {},
  };
}

export function byId<T>(list: T[], key: (t: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const t of list) out[key(t)] = t;
  return out;
}

/** Aplica o resultado de `bootstrap`, preservando mensagens, jobs e streams já carregados. */
export function applyBootstrap(state: DataState, b: BootstrapDTO): DataState {
  const approvals = byId(
    b.pendingApprovals.filter((a) => a.status === "pending"),
    (a) => a.id,
  );
  return {
    ...state,
    myUserId: b.me.userId,
    workspace: b.workspace,
    me: b.me,
    members: byId(b.members, (m) => m.userId),
    sectors: byId(b.sectors, (s) => s.id),
    agents: byId(b.agents, (a) => a.id),
    channels: byId(b.channels, (c) => c.id),
    runners: byId(b.runners, (r) => r.id),
    approvals,
    unreadNotifications: b.unreadNotifications,
  };
}

/** Insere ou substitui mantendo a ordem por `createdAt` (mais novas por último). */
export function upsertSorted(list: MessageDTO[], msg: MessageDTO): MessageDTO[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx >= 0) {
    const copy = list.slice();
    copy[idx] = msg;
    return copy;
  }
  const last = list[list.length - 1];
  if (!last || last.createdAt <= msg.createdAt) return [...list, msg];
  const copy = list.slice();
  let i = copy.length;
  while (i > 0 && copy[i - 1]!.createdAt > msg.createdAt) i--;
  copy.splice(i, 0, msg);
  return copy;
}

/** Junta uma página mais antiga (ou uma recarga) com o que já existe, sem duplicar. */
export function mergeMessages(existing: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  const map = new Map<string, MessageDTO>();
  for (const m of existing) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function updateInList(lists: Record<string, MessageList>, key: string, fn: (l: MessageList) => MessageList) {
  const l = lists[key];
  if (!l) return lists;
  return { ...lists, [key]: fn(l) };
}

function setReplyCount(list: MessageList, rootId: string, delta: number): MessageList {
  const idx = list.items.findIndex((m) => m.id === rootId);
  if (idx < 0) return list;
  const items = list.items.slice();
  const root = items[idx]!;
  items[idx] = { ...root, replyCount: Math.max(0, root.replyCount + delta) };
  return { ...list, items };
}

export const actorKey = (a: { type: string; id: string | null }): string => `${a.type}:${a.id ?? ""}`;

function onMessageCreated(state: DataState, msg: MessageDTO): DataState {
  let { messages, threads, channels, streams, typing } = state;
  if (msg.threadRootId) {
    const root = msg.threadRootId;
    const existed = threads[root]?.items.some((m) => m.id === msg.id) ?? false;
    threads = updateInList(threads, root, (l) => ({ ...l, items: upsertSorted(l.items, msg) }));
    if (!existed) messages = updateInList(messages, msg.channelId, (l) => setReplyCount(l, root, 1));
  } else {
    messages = updateInList(messages, msg.channelId, (l) => ({ ...l, items: upsertSorted(l.items, msg) }));
  }
  const ch = channels[msg.channelId];
  if (ch) {
    const fromMe = msg.author.type === "user" && msg.author.id === state.myUserId;
    const counts = !fromMe && state.activeChannelId !== msg.channelId && !msg.threadRootId;
    channels = {
      ...channels,
      [ch.id]: {
        ...ch,
        lastMessageAt: Math.max(ch.lastMessageAt ?? 0, msg.createdAt),
        unread: counts ? ch.unread + 1 : ch.unread,
      },
    };
  }
  if (msg.jobId && streams[msg.jobId]) {
    const { [msg.jobId]: _gone, ...rest } = streams;
    streams = rest;
  }
  // Quem mandou a mensagem parou de digitar.
  const t = typing[msg.channelId];
  const key = actorKey(msg.author);
  if (t && t[key]) {
    const { [key]: _x, ...restT } = t;
    typing = { ...typing, [msg.channelId]: restT };
  }
  return { ...state, messages, threads, channels, streams, typing };
}

function onMessageUpdated(state: DataState, msg: MessageDTO): DataState {
  const replace = (l: MessageList): MessageList =>
    l.items.some((m) => m.id === msg.id) ? { ...l, items: l.items.map((m) => (m.id === msg.id ? msg : m)) } : l;
  const messages = updateInList(state.messages, msg.channelId, replace);
  const threads = msg.threadRootId ? updateInList(state.threads, msg.threadRootId, replace) : state.threads;
  const threadRoots = state.threadRoots[msg.id] ? { ...state.threadRoots, [msg.id]: msg } : state.threadRoots;
  return { ...state, messages, threads, threadRoots };
}

function onMessageDeleted(state: DataState, channelId: string, messageId: string): DataState {
  const drop = (l: MessageList): MessageList => ({ ...l, items: l.items.filter((m) => m.id !== messageId) });
  let messages = updateInList(state.messages, channelId, drop);
  let threads = state.threads;
  for (const [root, l] of Object.entries(threads)) {
    if (l.items.some((m) => m.id === messageId)) {
      threads = { ...threads, [root]: drop(l) };
      messages = updateInList(messages, channelId, (cl) => setReplyCount(cl, root, -1));
    }
  }
  return { ...state, messages, threads };
}

export function applyEvent(state: DataState, event: ClientEvent, now: number): DataState {
  switch (event.type) {
    case "hello":
      return state.myUserId ? state : { ...state, myUserId: event.userId };
    case "message.created":
      return onMessageCreated(state, event.message);
    case "message.updated":
      return onMessageUpdated(state, event.message);
    case "message.deleted":
      return onMessageDeleted(state, event.channelId, event.messageId);
    case "channel.upserted": {
      const prev = state.channels[event.channel.id];
      const channel =
        prev && state.activeChannelId === event.channel.id ? { ...event.channel, unread: 0 } : event.channel;
      return { ...state, channels: { ...state.channels, [channel.id]: channel } };
    }
    case "channel.deleted": {
      const { [event.channelId]: _c, ...channels } = state.channels;
      const { [event.channelId]: _m, ...messages } = state.messages;
      return { ...state, channels, messages };
    }
    case "presence": {
      const m = state.members[event.userId];
      if (!m) return state;
      const updated = { ...m, online: event.online, runnerOnline: event.runnerOnline };
      return {
        ...state,
        members: { ...state.members, [m.userId]: updated },
        me: state.me?.userId === m.userId ? updated : state.me,
      };
    }
    case "typing": {
      if (event.actor.type === "user" && event.actor.id === state.myUserId) return state;
      const forChannel = { ...(state.typing[event.channelId] ?? {}) };
      for (const [k, exp] of Object.entries(forChannel)) if (exp <= now) delete forChannel[k];
      forChannel[actorKey(event.actor)] = now + TYPING_TTL_MS;
      return { ...state, typing: { ...state.typing, [event.channelId]: forChannel } };
    }
    case "job.updated": {
      const job = event.job;
      let streams = state.streams;
      // Cancelado ou com erro: a prévia em andamento some (o erro aparece no próprio job).
      if ((job.status === "cancelled" || job.status === "failed") && streams[job.id]) {
        const { [job.id]: _s, ...rest } = streams;
        streams = rest;
      }
      return { ...state, jobs: { ...state.jobs, [job.id]: job }, streams };
    }
    case "job.stream": {
      const job = state.jobs[event.jobId];
      if (job && (job.status === "cancelled" || job.status === "failed")) return state;
      return {
        ...state,
        streams: {
          ...state.streams,
          [event.jobId]: {
            jobId: event.jobId,
            channelId: event.channelId,
            agentId: event.agentId,
            text: event.text,
            updatedAt: now,
          },
        },
      };
    }
    case "job.event": {
      const list = state.jobEvents[event.event.jobId] ?? [];
      if (list.some((e) => e.id === event.event.id)) return state;
      return { ...state, jobEvents: { ...state.jobEvents, [event.event.jobId]: [...list, event.event] } };
    }
    case "agent.upserted":
      return { ...state, agents: { ...state.agents, [event.agent.id]: event.agent } };
    case "agent.deleted": {
      const { [event.agentId]: _a, ...agents } = state.agents;
      return { ...state, agents };
    }
    case "approval.upserted": {
      const a = event.approval;
      if (a.status === "pending") return { ...state, approvals: { ...state.approvals, [a.id]: a } };
      const { [a.id]: _x, ...approvals } = state.approvals;
      return { ...state, approvals };
    }
    case "notification.created": {
      if (state.notifications.some((n) => n.id === event.notification.id)) return state;
      return {
        ...state,
        notifications: [event.notification, ...state.notifications],
        unreadNotifications: state.unreadNotifications + (event.notification.read ? 0 : 1),
      };
    }
    case "runner.updated":
      return { ...state, runners: { ...state.runners, [event.runner.id]: event.runner } };
    case "task.upserted": {
      const prev = state.tasks[event.task.id];
      // Eventos fora de ordem: não troca uma versão mais nova por uma mais velha.
      if (prev && prev.updatedAt > event.task.updatedAt) return state;
      return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } };
    }
    case "task.deleted": {
      if (!state.tasks[event.taskId]) return state;
      const { [event.taskId]: _t, ...tasks } = state.tasks;
      return { ...state, tasks };
    }
    case "wiki.changed":
      return {
        ...state,
        wikiVersion: state.wikiVersion + 1,
        wikiPageVersions: { ...state.wikiPageVersions, [event.pageId]: (state.wikiPageVersions[event.pageId] ?? 0) + 1 },
      };
    case "file.created":
      if (!event.file.inDrive) return state;
      return { ...state, files: { ...state.files, [event.file.id]: event.file } };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

/** Quem está digitando agora num canal. */
export function typingActors(state: Pick<DataState, "typing">, channelId: string, now: number): string[] {
  const t = state.typing[channelId];
  if (!t) return [];
  return Object.entries(t)
    .filter(([, exp]) => exp > now)
    .map(([k]) => k);
}
