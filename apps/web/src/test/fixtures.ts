import type { BootstrapDTO, ChannelDTO, FileDTO, JobDTO, MessageDTO, TaskDTO } from "@puxibot/shared";

export function msg(p: Partial<MessageDTO> & { id: string }): MessageDTO {
  return {
    channelId: "c1",
    author: { type: "user", id: "u2" },
    body: "oi",
    threadRootId: null,
    replyCount: 0,
    quote: null,
    attachments: [],
    cards: [],
    mentions: [],
    reactions: [],
    jobId: null,
    meta: null,
    pinned: false,
    editedAt: null,
    deleted: false,
    createdAt: 1000,
    ...p,
  };
}

export function channel(p: Partial<ChannelDTO> & { id: string }): ChannelDTO {
  return { kind: "channel", name: p.id, section: null, topic: null, humansOnly: false, isPrivate: false, members: [], unread: 0, lastMessageAt: null, ...p };
}

export function job(p: Partial<JobDTO> & { id: string }): JobDTO {
  return {
    agentId: "a1",
    channelId: "c1",
    threadRootId: null,
    triggerMessageId: null,
    origin: "user",
    requestedByUserId: "u1",
    parentJobId: null,
    routineId: null,
    prompt: "",
    status: "queued",
    runnerId: null,
    runnerUserId: null,
    cli: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    error: null,
    errorCode: null,
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    waitingForRunner: false,
    ...p,
  };
}

export function bootstrap(p: Partial<BootstrapDTO> = {}): BootstrapDTO {
  return {
    workspace: { id: "w1", name: "W", kind: "team", business: null, routerEnabled: false, role: "member" },
    me: { userId: "u1", name: "Ana", email: "ana@x.com", avatarColor: null, role: "member", title: null, statusText: null, online: true, runnerOnline: false, sectorId: null },
    members: [
      { userId: "u1", name: "Ana", email: "ana@x.com", avatarColor: null, role: "member", title: null, statusText: null, online: true, runnerOnline: false, sectorId: null },
      { userId: "u2", name: "Bruno", email: "bruno@x.com", avatarColor: null, role: "admin", title: null, statusText: null, online: false, runnerOnline: false, sectorId: null },
    ],
    sectors: [],
    agents: [],
    channels: [channel({ id: "c1" }), channel({ id: "c2" })],
    runners: [],
    pendingApprovals: [],
    unreadNotifications: 0,
    ...p,
  };
}

export function task(p: Partial<TaskDTO> & { id: string }): TaskDTO {
  return {
    number: 1,
    title: "Tarefa",
    description: "",
    status: "todo",
    priority: "medium",
    labels: [],
    project: null,
    assignee: null,
    subtasks: [],
    links: [],
    sourceMessageId: null,
    createdBy: { type: "user", id: "u1" },
    commentCount: 0,
    position: 1000,
    createdAt: 1,
    updatedAt: 1,
    ...p,
  };
}

export function file(p: Partial<FileDTO> & { id: string }): FileDTO {
  return { name: "a.txt", mime: "text/plain", size: 10, folder: null, author: { type: "user", id: "u1" }, channelId: null, inDrive: true, createdAt: 1, ...p };
}
