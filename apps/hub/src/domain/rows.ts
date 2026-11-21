/**
 * Tipos das linhas do D1 (snake_case, como no schema) e mapeadores linha → DTO.
 * Mapeadores que precisam de dados de outras tabelas (agente, canal, mensagem) recebem esses dados prontos.
 */
import type {
  ActorRef,
  AgentDTO,
  ApprovalDTO,
  AttachmentDTO,
  ConnectorDTO,
  FileDTO,
  MemoryDTO,
  SkillDTO,
  TaskCommentDTO,
  TaskDTO,
  WikiPageDTO,
  WikiRevisionDTO,
  Cli,
  JobDTO,
  JobErrorCode,
  JobEventDTO,
  JobStatus,
  MemberDTO,
  MessageCard,
  MessageDTO,
  NotificationDTO,
  Role,
  RoutineDTO,
  RunnerDTO,
  SectorDTO,
  ToolLevel,
  UserDTO,
  WorkspaceDTO,
} from "@puxibot/shared";
import { bool, parseJson } from "../lib/db";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  avatar_color: string | null;
  created_at: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  kind: "personal" | "team";
  business: string | null;
  router_enabled: number;
  task_seq: number;
  created_by: string;
  created_at: number;
}

export interface MemberRow {
  workspace_id: string;
  user_id: string;
  role: Role;
  title: string | null;
  status_text: string | null;
  joined_at: number;
  sector_id: string | null;
}

export interface MemberWithUserRow extends MemberRow {
  name: string;
  email: string;
  avatar_color: string | null;
}

export interface SectorRow {
  id: string;
  workspace_id: string;
  name: string;
  lead_user_id: string | null;
}

export interface AgentRow {
  id: string;
  workspace_id: string;
  handle: string;
  name: string;
  role: string | null;
  description: string | null;
  instructions: string;
  avatar_color: string | null;
  avatar_accessory: string | null;
  sector_id: string | null;
  owner_user_id: string;
  is_assistant: number;
  access_mode: AgentDTO["accessMode"];
  agents_can_consult: number;
  callable_agents_mode: AgentDTO["callableAgentsMode"];
  callable_agents_json: string;
  preferred_cli: Cli | null;
  preferred_model: string | null;
  budget_tokens_month: number | null;
  budget_runs_month: number | null;
  budget_warned_period: string | null;
  self_start_policy: AgentDTO["selfStartPolicy"];
  max_concurrent_jobs: number;
  max_prs_per_hour: number;
  status: AgentDTO["status"];
  created_at: number;
  updated_at: number;
}

export interface ChannelRow {
  id: string;
  workspace_id: string;
  kind: "channel" | "dm";
  name: string | null;
  section: string | null;
  topic: string | null;
  humans_only: number;
  is_private: number;
  dm_key: string | null;
  created_by: string | null;
  created_at: number;
  last_message_at: number | null;
}

export interface ChannelMemberRow {
  channel_id: string;
  member_type: "user" | "agent";
  member_id: string;
  last_read_at: number;
  joined_at: number;
}

export interface MessageRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  author_type: "user" | "agent" | "system";
  author_id: string | null;
  body: string;
  thread_root_id: string | null;
  quote_json: string | null;
  attachments_json: string;
  cards_json: string;
  mentions_json: string;
  job_id: string | null;
  meta_json: string | null;
  pinned: number;
  edited_at: number | null;
  deleted_at: number | null;
  created_at: number;
  on_behalf_of_user_id: string | null;
}

export interface RunnerRow {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  platform: string | null;
  clis_json: string;
  isolation: RunnerDTO["isolation"];
  online: number;
  last_seen_at: number | null;
  created_at: number;
  token_id: string | null;
}

export interface JobRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  channel_id: string | null;
  thread_root_id: string | null;
  trigger_message_id: string | null;
  origin: JobDTO["origin"];
  requested_by_user_id: string | null;
  parent_job_id: string | null;
  routine_id: string | null;
  prompt: string;
  status: JobStatus;
  runner_id: string | null;
  runner_user_id: string | null;
  lease_expires_at: number | null;
  attempts: number;
  cli: Cli | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  result_text: string | null;
  error: string | null;
  error_code: JobErrorCode | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  no_runner_notified_at: number | null;
  task_id: string | null;
  waiting_for_runner: number;
}

export interface JobEventRow {
  id: number;
  job_id: string;
  kind: JobEventDTO["kind"];
  summary: string;
  created_at: number;
}

export interface ApprovalRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  job_id: string | null;
  kind: ApprovalDTO["kind"];
  title: string;
  details: string | null;
  approver_user_id: string;
  status: ApprovalDTO["status"];
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  created_at: number;
}

export interface NotificationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: NotificationDTO["kind"];
  title: string;
  body: string | null;
  link: string | null;
  read_at: number | null;
  created_at: number;
}

export interface RoutineRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  channel_id: string | null;
  enabled: number;
  kind: RoutineDTO["kind"];
  next_run_at: number | null;
  last_run_at: number | null;
  created_by: string;
  created_at: number;
}

export interface ApiTokenRow {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  kind: "personal" | "runner";
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
}

// ---------- Mapeadores ----------
export function toUserDTO(r: Pick<UserRow, "id" | "email" | "name" | "avatar_color">): UserDTO {
  return { id: r.id, email: r.email, name: r.name, avatarColor: r.avatar_color };
}

export function toWorkspaceDTO(r: WorkspaceRow, role: Role): WorkspaceDTO {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    business: r.business,
    routerEnabled: bool(r.router_enabled),
    role,
  };
}

export function toMemberDTO(r: MemberWithUserRow, presence: { online: boolean; runnerOnline: boolean }): MemberDTO {
  return {
    userId: r.user_id,
    name: r.name,
    email: r.email,
    avatarColor: r.avatar_color,
    role: r.role,
    title: r.title,
    statusText: r.status_text,
    online: presence.online,
    runnerOnline: presence.runnerOnline,
    sectorId: r.sector_id ?? null,
  };
}

export function toSectorDTO(r: SectorRow): SectorDTO {
  return { id: r.id, name: r.name, leadUserId: r.lead_user_id };
}

export function toAgentDTO(
  r: AgentRow,
  extra: {
    allowedUserIds: string[];
    toolPerms: Record<string, ToolLevel>;
    skillIds: string[];
    activity: AgentDTO["activity"];
  },
): AgentDTO {
  return {
    id: r.id,
    handle: r.handle,
    name: r.name,
    role: r.role,
    description: r.description,
    instructions: r.instructions,
    avatarColor: r.avatar_color,
    avatarAccessory: r.avatar_accessory,
    sectorId: r.sector_id,
    ownerUserId: r.owner_user_id,
    isAssistant: bool(r.is_assistant),
    accessMode: r.access_mode,
    allowedUserIds: extra.allowedUserIds,
    agentsCanConsult: bool(r.agents_can_consult),
    callableAgentsMode: r.callable_agents_mode,
    callableAgentIds: parseJson<string[]>(r.callable_agents_json, []),
    preferredCli: r.preferred_cli,
    preferredModel: r.preferred_model,
    budgetTokensMonth: r.budget_tokens_month,
    budgetRunsMonth: r.budget_runs_month,
    selfStartPolicy: r.self_start_policy,
    maxConcurrentJobs: r.max_concurrent_jobs,
    maxPrsPerHour: r.max_prs_per_hour,
    status: r.status,
    toolPerms: extra.toolPerms,
    skillIds: extra.skillIds,
    activity: extra.activity,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toMessageDTO(
  r: MessageRow,
  extra: { replyCount: number; reactions: { emoji: string; userIds: string[] }[] },
): MessageDTO {
  const deleted = r.deleted_at != null;
  return {
    id: r.id,
    channelId: r.channel_id,
    author: { type: r.author_type, id: r.author_id },
    body: deleted ? "" : r.body,
    threadRootId: r.thread_root_id,
    replyCount: extra.replyCount,
    quote: deleted ? null : parseJson<MessageDTO["quote"]>(r.quote_json, null),
    attachments: deleted ? [] : parseJson<AttachmentDTO[]>(r.attachments_json, []),
    cards: deleted ? [] : parseJson<MessageCard[]>(r.cards_json, []),
    mentions: parseJson<ActorRef[]>(r.mentions_json, []),
    reactions: extra.reactions,
    jobId: r.job_id,
    meta: parseJson<MessageDTO["meta"]>(r.meta_json, null),
    pinned: bool(r.pinned),
    editedAt: r.edited_at,
    deleted,
    createdAt: r.created_at,
    onBehalfOfUserId: r.on_behalf_of_user_id ?? null,
  };
}

export function toRunnerDTO(r: RunnerRow, online: boolean): RunnerDTO {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    platform: r.platform,
    clis: parseJson<RunnerDTO["clis"]>(r.clis_json, []),
    isolation: r.isolation,
    online,
    lastSeenAt: r.last_seen_at,
  };
}

export function toJobDTO(r: JobRow): JobDTO {
  return {
    id: r.id,
    agentId: r.agent_id,
    channelId: r.channel_id,
    threadRootId: r.thread_root_id,
    triggerMessageId: r.trigger_message_id,
    origin: r.origin,
    requestedByUserId: r.requested_by_user_id,
    parentJobId: r.parent_job_id,
    routineId: r.routine_id,
    prompt: r.prompt,
    status: r.status,
    runnerId: r.runner_id,
    runnerUserId: r.runner_user_id,
    cli: r.cli,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    error: r.error,
    errorCode: r.error_code,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    waitingForRunner: r.status === "queued" && r.waiting_for_runner === 1,
    taskId: r.task_id ?? null,
  };
}

export function toJobEventDTO(r: JobEventRow): JobEventDTO {
  return { id: r.id, jobId: r.job_id, kind: r.kind, summary: r.summary, createdAt: r.created_at };
}

export function toApprovalDTO(r: ApprovalRow): ApprovalDTO {
  return {
    id: r.id,
    agentId: r.agent_id,
    jobId: r.job_id,
    kind: r.kind,
    title: r.title,
    details: r.details,
    approverUserId: r.approver_user_id,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  };
}

export function toNotificationDTO(r: NotificationRow): NotificationDTO {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.link,
    read: r.read_at != null,
    createdAt: r.created_at,
  };
}

export function toRoutineDTO(r: RoutineRow): RoutineDTO {
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    prompt: r.prompt,
    cron: r.cron,
    timezone: r.timezone,
    channelId: r.channel_id,
    enabled: bool(r.enabled),
    kind: r.kind,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
  };
}

// ---------- Segunda leva ----------
export interface TaskRow {
  id: string;
  workspace_id: string;
  number: number;
  title: string;
  description: string;
  status: TaskDTO["status"];
  priority: TaskDTO["priority"];
  labels_json: string;
  project: string | null;
  assignee_type: "user" | "agent" | null;
  assignee_id: string | null;
  subtasks_json: string;
  links_json: string;
  source_message_id: string | null;
  created_by_type: "user" | "agent";
  created_by_id: string;
  position: number;
  created_at: number;
  updated_at: number;
  on_behalf_of_user_id: string | null;
}

export interface TaskCommentRow {
  id: string;
  task_id: string;
  author_type: "user" | "agent";
  author_id: string;
  body: string;
  created_at: number;
  on_behalf_of_user_id: string | null;
}

export interface WikiPageRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  is_folder: number;
  title: string;
  body: string;
  version: number;
  deleted_at: number | null;
  created_by_type: "user" | "agent";
  created_by_id: string;
  updated_by_type: "user" | "agent";
  updated_by_id: string;
  on_behalf_of_user_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WikiRevisionRow {
  id: string;
  page_id: string;
  version: number;
  title: string;
  body: string;
  author_type: "user" | "agent";
  author_id: string;
  on_behalf_of_user_id: string | null;
  note: string | null;
  created_at: number;
}

export interface FileRow {
  id: string;
  workspace_id: string;
  r2_key: string;
  name: string;
  mime: string;
  size: number;
  folder: string | null;
  author_type: "user" | "agent";
  author_id: string;
  channel_id: string | null;
  in_drive: number;
  created_at: number;
  on_behalf_of_user_id: string | null;
}

export interface MemoryRow {
  id: string;
  workspace_id: string;
  scope: "agent" | "team";
  agent_id: string | null;
  content: string;
  source: MemoryDTO["source"];
  created_by_type: "user" | "agent";
  created_by_id: string;
  created_at: number;
  updated_at: number;
  on_behalf_of_user_id: string | null;
}

export interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  body: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ConnectorRow {
  id: string;
  workspace_id: string;
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args_json: string;
  secrets_enc: string | null;
  owner_user_id: string;
  created_at: number;
}

export function toTaskDTO(r: TaskRow, commentCount: number): TaskDTO {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    labels: parseJson<string[]>(r.labels_json, []),
    project: r.project,
    assignee: r.assignee_type && r.assignee_id ? { type: r.assignee_type, id: r.assignee_id } : null,
    subtasks: parseJson<TaskDTO["subtasks"]>(r.subtasks_json, []),
    links: parseJson<TaskDTO["links"]>(r.links_json, []),
    sourceMessageId: r.source_message_id,
    createdBy: { type: r.created_by_type, id: r.created_by_id },
    commentCount,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    onBehalfOfUserId: r.on_behalf_of_user_id ?? null,
  };
}

export function toTaskCommentDTO(r: TaskCommentRow): TaskCommentDTO {
  return {
    id: r.id,
    taskId: r.task_id,
    author: { type: r.author_type, id: r.author_id },
    body: r.body,
    createdAt: r.created_at,
    onBehalfOfUserId: r.on_behalf_of_user_id ?? null,
  };
}

export function toWikiPageDTO(r: WikiPageRow, withBody = true): WikiPageDTO {
  return {
    id: r.id,
    parentId: r.parent_id,
    isFolder: bool(r.is_folder),
    title: r.title,
    body: withBody ? r.body : "",
    version: r.version,
    deleted: r.deleted_at != null,
    updatedBy: { type: r.updated_by_type, id: r.updated_by_id },
    onBehalfOfUserId: r.on_behalf_of_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toWikiRevisionDTO(r: WikiRevisionRow): WikiRevisionDTO {
  return {
    id: r.id,
    pageId: r.page_id,
    version: r.version,
    title: r.title,
    body: r.body,
    author: { type: r.author_type, id: r.author_id },
    onBehalfOfUserId: r.on_behalf_of_user_id,
    note: r.note,
    createdAt: r.created_at,
  };
}

export function toFileDTO(r: FileRow): FileDTO {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    folder: r.folder,
    author: { type: r.author_type, id: r.author_id },
    channelId: r.channel_id,
    inDrive: bool(r.in_drive),
    createdAt: r.created_at,
    onBehalfOfUserId: r.on_behalf_of_user_id ?? null,
  };
}

export function toMemoryDTO(r: MemoryRow): MemoryDTO {
  return {
    id: r.id,
    scope: r.scope,
    agentId: r.agent_id,
    content: r.content,
    source: r.source,
    createdBy: { type: r.created_by_type, id: r.created_by_id },
    onBehalfOfUserId: r.on_behalf_of_user_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toSkillDTO(r: SkillRow): SkillDTO {
  return { id: r.id, name: r.name, description: r.description, body: r.body, updatedAt: r.updated_at, createdBy: r.created_by };
}

export function toConnectorDTO(r: ConnectorRow, secretNames?: { headers: string[]; env: string[] }): ConnectorDTO {
  return {
    id: r.id,
    name: r.name,
    transport: r.transport,
    url: r.url,
    command: r.command,
    args: parseJson<string[]>(r.args_json, []),
    ownerUserId: r.owner_user_id,
    hasSecrets: r.secrets_enc != null,
    ...(secretNames ? { secretHeaderNames: secretNames.headers, secretEnvNames: secretNames.env } : {}),
    createdAt: r.created_at,
  };
}
