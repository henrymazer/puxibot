/**
 * Contrato compartilhado entre hub, web e runner.
 * DTOs espelham as tabelas de apps/hub/migrations/0001_init.sql em camelCase,
 * com colunas *_json já desserializadas e booleanos no lugar de 0/1.
 * Datas são números (ms desde epoch).
 */
import { z } from "zod";

// ---------- Enumerações ----------
export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const CLIS = ["claude", "codex", "gemini"] as const;
export type Cli = (typeof CLIS)[number];

export const ISOLATION_MODES = ["sandbox", "container", "none"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export const TASK_STATUSES = ["todo", "doing", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const JOB_STATUSES = [
  "awaiting_approval",
  "queued",
  "assigned",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_ERROR_CODES = ["auth", "limit", "timeout", "runner_lost", "error"] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** Ferramentas nativas sujeitas a permissão por agente. Conectores usam `connector:<id>`. */
export const NATIVE_TOOLS = ["messages", "memory", "tasks", "wiki", "drive", "agents"] as const;
export type NativeTool = (typeof NATIVE_TOOLS)[number];
export type ToolLevel = "none" | "read" | "write";

export type ActorType = "user" | "agent";
export interface ActorRef {
  type: ActorType;
  id: string;
}

// ---------- DTOs ----------
export interface UserDTO {
  id: string;
  email: string;
  name: string;
  avatarColor: string | null;
}

export interface WorkspaceDTO {
  id: string;
  name: string;
  kind: "personal" | "team";
  business: string | null;
  routerEnabled: boolean;
  role: Role; // papel de quem está consultando
}

export interface MemberDTO {
  userId: string;
  name: string;
  email: string;
  avatarColor: string | null;
  role: Role;
  title: string | null;
  statusText: string | null;
  online: boolean;
  runnerOnline: boolean;
  /** Setor da pessoa (migração 0003). Admin muda via PATCH /members/:userId { sectorId }. */
  sectorId: string | null;
}

export interface SectorDTO {
  id: string;
  name: string;
  leadUserId: string | null;
}

export interface AgentDTO {
  id: string;
  handle: string;
  name: string;
  role: string | null;
  description: string | null;
  instructions: string;
  avatarColor: string | null;
  avatarAccessory: string | null;
  sectorId: string | null;
  ownerUserId: string;
  isAssistant: boolean;
  accessMode: "workspace" | "restricted" | "owner";
  allowedUserIds: string[]; // accessMode = 'restricted'
  agentsCanConsult: boolean;
  callableAgentsMode: "all" | "only" | "none";
  callableAgentIds: string[];
  preferredCli: Cli | null;
  preferredModel: string | null;
  budgetTokensMonth: number | null;
  budgetRunsMonth: number | null;
  selfStartPolicy: "ask" | "run";
  maxConcurrentJobs: number;
  maxPrsPerHour: number;
  status: "active" | "paused";
  toolPerms: Record<string, ToolLevel>; // chave: NativeTool ou `connector:<id>`
  skillIds: string[];
  /** Estado calculado para a interface. */
  activity: "idle" | "working" | "waiting_approval" | "queued_no_runner" | "error";
  createdAt: number;
  updatedAt: number;
}

export interface AgentUsageDTO {
  period: string; // 'YYYY-MM'
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** Uso por pessoa cuja assinatura executou. */
  byRunnerUser: { userId: string; runs: number; tokens: number }[];
}

export interface SkillDTO {
  id: string;
  name: string;
  description: string;
  body: string;
  updatedAt: number;
  /** Quem criou (id da pessoa). Só ela ou um admin edita/apaga. */
  createdBy?: string;
}

export interface MemoryDTO {
  id: string;
  scope: "agent" | "team";
  agentId: string | null;
  content: string;
  source: "agent" | "user" | "extraction";
  createdBy: ActorRef;
  /** Agente agindo em nome desta pessoa (quando criada pela API de ferramentas). */
  onBehalfOfUserId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectorDTO {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  ownerUserId: string;
  hasSecrets: boolean;
  /** Nomes (sem valores) dos cabeçalhos e variáveis de ambiente secretos gravados. */
  secretHeaderNames?: string[];
  secretEnvNames?: string[];
  createdAt?: number;
}

export interface ChannelDTO {
  id: string;
  kind: "channel" | "dm";
  name: string | null;
  section: string | null;
  topic: string | null;
  humansOnly: boolean;
  isPrivate: boolean;
  members: ActorRef[];
  unread: number;
  lastMessageAt: number | null;
}

export type MessageCard =
  | { type: "bars"; title: string; subtitle?: string; rows: { label: string; value: number; display?: string }[] }
  | { type: "table"; title?: string; columns: string[]; rows: string[][] }
  | { type: "checklist"; title: string; items: { label: string; done: boolean; link?: string }[] }
  | { type: "stats"; title?: string; items: { label: string; value: string }[] };

export interface AttachmentDTO {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

export interface MessageDTO {
  id: string;
  channelId: string;
  author: { type: ActorType | "system"; id: string | null };
  body: string;
  threadRootId: string | null;
  replyCount: number;
  quote: { messageId: string; text: string } | null;
  attachments: AttachmentDTO[];
  cards: MessageCard[];
  mentions: ActorRef[];
  reactions: { emoji: string; userIds: string[] }[];
  jobId: string | null;
  meta: { cli?: Cli; model?: string; runnerUserId?: string; runnerName?: string } | null;
  pinned: boolean;
  editedAt: number | null;
  deleted: boolean;
  createdAt: number;
  /** Mensagem de agente feita em nome desta pessoa ("Tito, em nome de Renato"). */
  onBehalfOfUserId?: string | null;
}

/** GET /channels/:id/messages */
export interface MessagesPageDTO {
  items: MessageDTO[];
  /** Cursor para a página anterior (`?before=`), ou null quando não há mais. Formato "<createdAt>:<id>". */
  nextBefore: string | null;
  /** Com `threadRootId`: a mensagem raiz da thread (também vai em `items[0]` na página mais antiga). */
  root?: MessageDTO | null;
}

export interface RunnerDTO {
  id: string;
  userId: string;
  name: string;
  platform: string | null;
  clis: { cli: Cli; version: string | null; loggedIn: boolean | null }[];
  isolation: IsolationMode | null;
  online: boolean;
  lastSeenAt: number | null;
}

export interface JobDTO {
  id: string;
  agentId: string;
  channelId: string | null;
  threadRootId: string | null;
  triggerMessageId: string | null;
  origin: "user" | "routine" | "agent" | "system";
  requestedByUserId: string | null;
  parentJobId: string | null;
  routineId: string | null;
  prompt: string;
  status: JobStatus;
  runnerId: string | null;
  runnerUserId: string | null;
  cli: Cli | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  errorCode: JobErrorCode | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Job `queued` sem nenhum runner elegível online (mantido pelo hub a cada reavaliação da fila). */
  waitingForRunner: boolean;
  /** Tarefa que originou o job (atribuição ou menção em comentário). */
  taskId?: string | null;
}

export interface JobEventDTO {
  id: number;
  jobId: string;
  kind: "tool" | "status" | "note";
  summary: string;
  createdAt: number;
}

export interface RoutineDTO {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  channelId: string | null;
  enabled: boolean;
  kind: "custom" | "daily_summary";
  nextRunAt: number | null;
  lastRunAt: number | null;
}

export interface ApprovalDTO {
  id: string;
  agentId: string;
  jobId: string | null;
  kind: "job_start" | "action";
  title: string;
  details: string | null;
  approverUserId: string;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
  createdAt: number;
}

export interface TaskDTO {
  id: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  labels: string[];
  project: string | null;
  assignee: ActorRef | null;
  subtasks: { id: string; title: string; done: boolean }[];
  links: { kind: "pr" | "issue" | "url"; label: string; url: string }[];
  sourceMessageId: string | null;
  createdBy: ActorRef;
  commentCount: number;
  position: number;
  createdAt: number;
  updatedAt: number;
  onBehalfOfUserId?: string | null;
}

export interface TaskCommentDTO {
  id: string;
  taskId: string;
  author: ActorRef;
  body: string;
  createdAt: number;
  onBehalfOfUserId?: string | null;
}

export interface WikiPageDTO {
  id: string;
  parentId: string | null;
  isFolder: boolean;
  title: string;
  body: string; // vazio nas listagens
  version: number;
  deleted: boolean;
  updatedBy: ActorRef;
  onBehalfOfUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WikiRevisionDTO {
  id: string;
  pageId: string;
  version: number;
  title: string;
  body: string;
  author: ActorRef;
  onBehalfOfUserId: string | null;
  note: string | null;
  createdAt: number;
}

export interface WikiStatsDTO {
  readsThisWeek: number;
  readers: { reader: ActorRef; count: number; lastAt: number }[];
  mentionedIn: { kind: "page" | "message"; id: string; title: string; excerpt: string }[];
}

export interface FileDTO {
  id: string;
  name: string;
  mime: string;
  size: number;
  folder: string | null;
  author: ActorRef;
  channelId: string | null;
  inDrive: boolean;
  createdAt: number;
  onBehalfOfUserId?: string | null;
}

export interface NotificationDTO {
  id: string;
  kind: "mention" | "dm" | "approval" | "budget" | "job_failed" | "no_runner";
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: number;
}

export interface ApiError {
  error: { code: string; message: string };
}

/** Token pessoal ou de runner, sem o segredo (GET /tokens). */
export interface ApiTokenDTO {
  id: string;
  name: string;
  kind: "personal" | "runner";
  createdAt: number;
  lastUsedAt: number | null;
}

// ---------- Respostas compostas ----------
/** GET /api/me */
export interface MeResponse {
  user: UserDTO;
  workspaces: WorkspaceDTO[];
}

/** GET /api/workspaces/:ws/bootstrap */
export interface BootstrapDTO {
  workspace: WorkspaceDTO;
  me: MemberDTO;
  members: MemberDTO[];
  sectors: SectorDTO[];
  agents: AgentDTO[];
  channels: ChannelDTO[];
  runners: RunnerDTO[];
  pendingApprovals: ApprovalDTO[];
  unreadNotifications: number;
}

/** GET /api/workspaces/:ws/search?q= */
export interface SearchResultsDTO {
  messages: MessageDTO[];
  tasks: TaskDTO[];
  wikiPages: WikiPageDTO[];
  files: FileDTO[];
}

/** GET /api/workspaces/:ws/wiki-graph */
export interface WikiGraphDTO {
  nodes: { id: string; title: string }[];
  edges: { from: string; to: string }[];
}

/** POST /api/workspaces/:ws/starter-team */
export interface StarterTeamResponse {
  /** Chave do modelo usado: 'agencia' | 'loja' | 'software' | 'servicos' | 'generico'. */
  template: string;
  agents: AgentDTO[];
  channels: ChannelDTO[];
  createdAgents: number;
  createdChannels: number;
}

/** GET/POST /api/telegram/link */
export interface TelegramLinkDTO {
  botUsername: string;
  linkCode: string;
  linked: boolean;
}

/** GET /api/me/notifications — notificações de todos os workspaces (usado pelo service worker após um push sem conteúdo). */
export interface MyNotificationDTO extends NotificationDTO {
  workspaceId: string;
}

/** POST /api/workspaces/:ws/invites */
export interface InviteCreatedDTO {
  code: string;
  url: string;
}

// ---------- Tempo real: hub -> navegador ----------
/** Enviados pelo WebSocket `/api/workspaces/:ws/realtime` (JSON por mensagem). */
export type ClientEvent =
  | { type: "hello"; userId: string; serverTime: number }
  | { type: "message.created"; message: MessageDTO }
  | { type: "message.updated"; message: MessageDTO }
  | { type: "message.deleted"; channelId: string; messageId: string }
  | { type: "channel.upserted"; channel: ChannelDTO }
  | { type: "channel.deleted"; channelId: string }
  | { type: "presence"; userId: string; online: boolean; runnerOnline: boolean }
  | { type: "typing"; channelId: string; actor: ActorRef }
  | { type: "job.updated"; job: JobDTO }
  /** Texto parcial da resposta em andamento; `text` é o acumulado até aqui. */
  | { type: "job.stream"; jobId: string; channelId: string | null; agentId: string; text: string }
  | { type: "job.event"; event: JobEventDTO }
  | { type: "agent.upserted"; agent: AgentDTO }
  | { type: "agent.deleted"; agentId: string }
  | { type: "task.upserted"; task: TaskDTO }
  | { type: "task.deleted"; taskId: string }
  | { type: "wiki.changed"; pageId: string }
  | { type: "file.created"; file: FileDTO }
  | { type: "approval.upserted"; approval: ApprovalDTO }
  | { type: "notification.created"; notification: NotificationDTO }
  | { type: "runner.updated"; runner: RunnerDTO };

/** Enviados pelo navegador no mesmo WebSocket. */
export type ClientCommand =
  | { type: "ping" }
  | { type: "typing"; channelId: string }
  | { type: "read"; channelId: string };

// ---------- Protocolo hub <-> runner ----------
/**
 * WebSocket `/api/workspaces/:ws/runner` autenticado por `Authorization: Bearer tb_...`
 * (token de kind 'runner'). JSON por mensagem.
 */
export const RUNNER_PROTOCOL_VERSION = 1;
/** O runner renova a posse de um job enviando `job.heartbeat` neste intervalo. */
export const JOB_HEARTBEAT_MS = 15_000;
/** Sem heartbeat por este tempo, o hub devolve o job para a fila. */
export const JOB_LEASE_MS = 60_000;
export const JOB_MAX_ATTEMPTS = 3;
/**
 * Jobs filhos (`origin = 'agent'`, consulta entre agentes) cujo pai roda num runner
 * podem ir para esse mesmo runner acima da `capacity`, até este tanto de jobs a mais.
 * Sem isso, um runner com capacidade 1 nunca executaria a consulta do próprio agente.
 */
/** Revisão automática de memória ao fim de um trabalho: limites por trabalho. */
export const MEMORY_REVIEW_MAX_ADD = 3;
export const MEMORY_REVIEW_MAX_REMOVE = 3;
export const MEMORY_REVIEW_MAX_CHARS = 500;
/** Por quanto tempo depois de terminar o trabalho o runner ainda pode mandar a revisão. */
export const MEMORY_REVIEW_GRACE_MS = 3 * 60_000;

export const CHILD_JOB_EXTRA_CAPACITY = 3;

export interface JobContextMessage {
  author: string; // nome de exibição
  authorType: ActorType | "system";
  body: string;
  createdAt: number;
}

/** Tudo que o runner precisa para executar um job. */
export interface JobAssignment {
  jobId: string;
  /** Token de curta duração, com escopo deste job, para a API de ferramentas (`/api/tool/*`). */
  jobToken: string;
  hubUrl: string;
  workspace: { id: string; name: string };
  agent: {
    id: string;
    handle: string;
    name: string;
    role: string | null;
    instructions: string;
    isAssistant: boolean;
    preferredCli: Cli | null;
    preferredModel: string | null;
    toolPerms: Record<string, ToolLevel>;
    skills: { name: string; description: string; body: string }[];
  };
  origin: JobDTO["origin"];
  /** Job pai (consulta entre agentes / tarefa criada por agente). Opcional: hubs antigos não enviam. */
  parentJobId?: string | null;
  requestedBy: { userId: string; name: string } | null;
  channel: { id: string; kind: "channel" | "dm"; name: string | null } | null;
  threadRootId: string | null;
  prompt: string;
  /** Mensagens recentes do canal/thread, mais antigas primeiro. */
  context: JobContextMessage[];
  /**
   * Memórias do agente e do time. `id` e `removable` servem à revisão automática de memória:
   * só as que não foram escritas por uma pessoa podem ser apagadas por ela.
   */
  memories: { scope: "agent" | "team"; content: string; id?: string; removable?: boolean }[];
  teammates: { handle: string; name: string; role: string | null }[];
  /** Conectores liberados para este agente, com segredos já decifrados. */
  connectors: {
    id: string;
    name: string;
    transport: "http" | "stdio";
    url: string | null;
    command: string | null;
    args: string[];
    headers: Record<string, string>;
    env: Record<string, string>;
    level: ToolLevel;
  }[];
  /** Chave para retomar a sessão da CLI: mesmo agente + mesmo canal/thread. */
  sessionKey: string;
  timeoutMs: number;
}

export type RunnerToHub =
  | {
      type: "hello";
      protocol: number;
      runnerId: string | null; // null no primeiro registro
      name: string;
      platform: string;
      clis: RunnerDTO["clis"];
      isolation: IsolationMode;
      /** Quantos jobs aceita ao mesmo tempo. */
      capacity: number;
    }
  | { type: "ping" }
  | { type: "job.accepted"; jobId: string; cli: Cli; model: string | null }
  | { type: "job.rejected"; jobId: string; reason: string }
  | { type: "job.heartbeat"; jobId: string }
  | { type: "job.stream"; jobId: string; text: string } // texto acumulado
  | { type: "job.event"; jobId: string; kind: "tool" | "status" | "note"; summary: string }
  | {
      type: "job.done";
      jobId: string;
      text: string;
      cards?: MessageCard[];
      inputTokens: number;
      outputTokens: number;
      model: string | null;
    }
  | { type: "job.failed"; jobId: string; errorCode: JobErrorCode; error: string };

/** `POST /api/runner/pair/start` → resposta. */
export interface RunnerPairStartResponse {
  pairCode: string;
  pollToken: string;
  /** Opcional: endereço da interface onde a pessoa aprova o código. */
  approveUrl?: string;
  /** Opcional: quando o código expira (ms). */
  expiresAt?: number;
}

/** `POST /api/runner/pair/poll` → resposta. `expired` é opcional (o hub também pode responder 404/410). */
export type RunnerPairPollResponse =
  | { status: "pending" }
  | { status: "approved"; token: string; workspaceId: string; hubUrl: string }
  | { status: "expired" };

export type HubToRunner =
  | { type: "welcome"; runnerId: string; userId: string; serverTime: number }
  | { type: "pong" }
  | { type: "job.assign"; assignment: JobAssignment }
  | { type: "job.cancel"; jobId: string }
  | { type: "error"; code: string; message: string };

// ---------- Validação de entradas mais usadas ----------
export const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "use minúsculas, números, - ou _");

export const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
  inviteCode: z.string().optional(),
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["personal", "team"]).default("team"),
  business: z.string().max(200).optional(),
});

export const sendMessageSchema = z.object({
  body: z.string().max(20_000),
  threadRootId: z.string().optional(),
  quote: z.object({ messageId: z.string(), text: z.string().max(2000) }).optional(),
  attachmentIds: z.array(z.string()).max(10).optional(),
});

export const createAgentSchema = z.object({
  handle: handleSchema,
  name: z.string().min(1).max(60),
  role: z.string().max(60).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().max(50_000).default(""),
  sectorId: z.string().optional(),
  ownerUserId: z.string().optional(), // padrão: quem cria
  avatarColor: z.string().max(20).optional(),
  avatarAccessory: z.string().max(20).optional(),
});

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;

export const createTaskSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).default(""),
  status: z.enum(TASK_STATUSES).default("todo"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  labels: z.array(z.string().max(40)).max(10).default([]),
  project: z.string().max(60).optional(),
  assignee: z.object({ type: z.enum(["user", "agent"]), id: z.string() }).nullable().optional(),
  sourceMessageId: z.string().optional(),
});

export const createRoutineSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(100),
  prompt: z.string().max(20_000).default(""),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).default("America/Sao_Paulo"),
  channelId: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
});

// ---------- Utilidades ----------
/** Extrai handles mencionados com @ (sem o @), em minúsculas e sem repetição. */
export function extractMentions(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9_-]{1,31})\b/gi)) {
    found.add(m[2]!.toLowerCase());
  }
  return [...found];
}

/**
 * Handle de menção de uma pessoa (pessoas não têm handle próprio no banco):
 * parte local do e-mail, em minúsculas, com caracteres fora de [a-z0-9_-] trocados por "-".
 * Ex.: "Ana.Souza+x@empresa.com" -> "ana-souza-x".
 */
export function userHandle(user: { email: string }): string {
  const local = (user.email.split("@")[0] ?? "").toLowerCase();
  const slug = local.replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return (slug || "pessoa").slice(0, 32);
}

/** Chave de DM: participantes ordenados, ex.: "a:123|u:456". */
export function dmKey(a: ActorRef, b: ActorRef): string {
  return [a, b]
    .map((p) => `${p.type === "agent" ? "a" : "u"}:${p.id}`)
    .sort()
    .join("|");
}

export function currentPeriod(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}
