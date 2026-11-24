/**
 * Cliente HTTP tipado único para a API do hub (docs/contrato-api.md).
 * Todas as chamadas da interface passam por aqui; ajustes de integração ficam concentrados neste arquivo.
 */
import type {
  ActorRef,
  AgentDTO,
  AgentUsageDTO,
  ApiError,
  ApiTokenDTO,
  ApprovalDTO,
  BootstrapDTO,
  ChannelDTO,
  ConnectorDTO,
  FileDTO,
  InviteCreatedDTO,
  JobDTO,
  JobEventDTO,
  MeResponse,
  MemberDTO,
  MemoryDTO,
  MessageDTO,
  NotificationDTO,
  Role,
  RoutineDTO,
  RunnerDTO,
  SearchResultsDTO,
  SectorDTO,
  SkillDTO,
  StarterTeamResponse,
  TaskCommentDTO,
  TaskDTO,
  TaskStatus,
  UserDTO,
  WikiPageDTO,
  WikiRevisionDTO,
  WikiGraphDTO,
  WikiStatsDTO,
  WorkspaceDTO,
  TelegramLinkDTO,
  MyNotificationDTO,
  CatalogApp,
  ChatLinkDTO,
  ConnectorAuthMethod,
  SetupPlan,
  SetupPlanDTO,
  SetupSessionDTO,
  TrustRuleDTO,
  UsageEntryDTO,
  UsageSummaryDTO,
  VaultItemDTO,
} from "@puxibot/shared";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  /** Segundos de espera pedidos pelo hub (`Retry-After` do 429), quando vierem. */
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** `Retry-After` em segundos (número ou data HTTP); null se ausente ou inválido. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "1 min", "15 min", "2 h": arredonda para cima, nunca menos de 1 min. */
export function formatWait(seconds: number): string {
  const min = Math.max(1, Math.ceil(seconds / 60));
  if (min < 90) return `${min} min`;
  return `${Math.ceil(min / 60)} h`;
}

/**
 * Mensagem para a pessoa a partir do erro do hub. Quase sempre é a `message` do próprio hub (já em
 * português e específica); alguns códigos ganham um texto que diz o que fazer.
 */
export function friendlyError(status: number, code: string, serverMessage: string | undefined, retryAfter: number | null): string {
  switch (code) {
    case "rate_limited":
      return retryAfter != null
        ? `Muitas tentativas. Tente de novo em ${formatWait(retryAfter)}.`
        : serverMessage ?? "Muitas tentativas. Espere alguns minutos e tente de novo.";
    case "workspace_limit":
      return serverMessage ?? "Você chegou ao limite de workspaces criados por pessoa.";
    case "body_too_large":
      return "O conteúdo enviado é grande demais. Encurte o texto ou divida em partes.";
    case "file_too_large":
      return serverMessage ?? "Arquivo grande demais (máximo de 25 MB).";
    case "length_required":
      return "O navegador não informou o tamanho do arquivo. Tente enviar de novo; se continuar, use outro navegador.";
    case "csrf_origin":
      return "O hub recusou o pedido porque ele não veio do endereço do hub. Abra o Puxibot pelo endereço oficial e recarregue a página.";
    case "invalid_push_endpoint":
      return "Este navegador ofereceu um endereço de notificação que o hub não aceita. Tente outro navegador ou use o Telegram.";
    case "assistant_owner_only":
      return serverMessage ?? "O assistente pessoal só é configurado pela pessoa dona dele. Admins podem pausar e definir orçamento.";
  }
  if (status === 429 && retryAfter != null) return `Muitas tentativas. Tente de novo em ${formatWait(retryAfter)}.`;
  return serverMessage ?? defaultMessage(status);
}

/** Mensagem pronta para mostrar à pessoa, para qualquer erro. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof TypeError) return "Não foi possível falar com o servidor. Verifique sua conexão.";
  if (err instanceof Error && err.message) return err.message;
  return "Algo deu errado. Tente de novo.";
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** URL pública para abrir um arquivo (o modo demonstração troca por blob:). */
  fileUrl?: (ws: string, fileId: string) => string;
}

export interface SignupInput {
  email: string;
  name: string;
  password: string;
  inviteCode?: string;
}
export interface CreateWorkspaceInput {
  name: string;
  kind: "personal" | "team";
  business?: string;
}
export interface CreateChannelInput {
  name: string;
  section?: string;
  topic?: string;
  humansOnly?: boolean;
  isPrivate?: boolean;
  members?: ActorRef[];
}
export interface SendMessageInput {
  body: string;
  threadRootId?: string;
  quote?: { messageId: string; text: string };
  attachmentIds?: string[];
}
export interface ListMessagesQuery {
  before?: number;
  limit?: number;
  threadRootId?: string;
  pinned?: boolean;
}
export interface CreateAgentInput {
  handle: string;
  name: string;
  role?: string;
  description?: string;
  instructions?: string;
  sectorId?: string;
  ownerUserId?: string;
  avatarColor?: string;
  avatarAccessory?: string;
}
export type AgentPatch = Partial<
  Omit<AgentDTO, "id" | "activity" | "createdAt" | "updatedAt" | "isAssistant">
>;
export type ActivityItem = JobDTO & { events: JobEventDTO[] };

// ---------- Segunda leva ----------
export interface TaskQuery {
  status?: TaskStatus;
  /** "user:<id>", "agent:<id>" ou "none". */
  assignee?: string;
  project?: string;
  label?: string;
  q?: string;
}
export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskDTO["priority"];
  labels?: string[];
  project?: string;
  assignee?: ActorRef | null;
  sourceMessageId?: string;
}
export type TaskPatch = Partial<
  Pick<TaskDTO, "title" | "description" | "status" | "priority" | "labels" | "project" | "assignee" | "subtasks" | "links" | "position">
>;
export interface WikiPatch {
  title?: string;
  body?: string;
  parentId?: string | null;
  note?: string;
  baseVersion?: number;
}
export interface RoutineInput {
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  channelId: string | null;
  enabled: boolean;
}
export interface SkillInput {
  name: string;
  description: string;
  body: string;
}
export interface ConnectorInput {
  name: string;
  transport: "http" | "stdio";
  url?: string | null;
  command?: string | null;
  args?: string[];
  /** Só escrita: nunca volta no GET. Omitido = mantém o que já existe. */
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** "oauth" = login pelo navegador (o hub guarda e renova o acesso). */
  auth?: "static" | "oauth";
  oauthClientId?: string | null;
  oauthScope?: string | null;
}
export interface CatalogConnectInput {
  catalogId: string;
  name?: string;
  method: ConnectorAuthMethod;
  token?: string;
  clientId?: string;
  grantAgentIds?: string[];
}
export interface VaultInput {
  name: string;
  site: string;
  username: string;
  password: string;
}
/** O que este hub tem ligado (GET /features). */
export interface HubFeatures {
  transcription: boolean;
  telegramChat: boolean;
  whatsappChat: boolean;
  trustModel: boolean;
}
export const NO_FEATURES: HubFeatures = { transcription: false, telegramChat: false, whatsappChat: false, trustModel: false };

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(query: Query | undefined): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    p.set(k, v === true ? "1" : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * O contrato nem sempre diz se a resposta vem embrulhada (`{ agent }`) ou crua (`AgentDTO`).
 * Aceita as duas formas.
 */
function unwrap<T>(data: unknown, key: string): T {
  if (data && typeof data === "object" && key in data) {
    const inner = (data as Record<string, unknown>)[key];
    if (inner && typeof inner === "object") return inner as T;
  }
  return data as T;
}

function items<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: T[] }).items;
  }
  return [];
}

export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly fileUrlImpl?: (ws: string, fileId: string) => string;
  /** Chamado em toda resposta 401 (sessão expirada). */
  onUnauthorized: (() => void) | null = null;

  constructor(opts: ApiClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = opts.baseUrl ?? "";
    this.fileUrlImpl = opts.fileUrl;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const init: RequestInit = { method, credentials: "include", headers: {} };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
    const res = await this.fetchImpl(`${this.baseUrl}/api${path}${qs(query)}`, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const err = (data as ApiError | undefined)?.error;
      if (res.status === 401 && this.onUnauthorized && !path.startsWith("/auth/")) this.onUnauthorized();
      const code = err?.code ?? `http_${res.status}`;
      const retryAfter = parseRetryAfter(res.headers?.get?.("Retry-After"));
      throw new ApiClientError(res.status, code, friendlyError(res.status, code, err?.message, retryAfter), retryAfter);
    }
    return data as T;
  }

  private w(ws: string, rest = ""): string {
    return `/workspaces/${encodeURIComponent(ws)}${rest}`;
  }

  // ---------- Auth e conta ----------
  async signup(input: SignupInput): Promise<UserDTO> {
    return unwrap<UserDTO>(await this.request("POST", "/auth/signup", input), "user");
  }
  /** Se dá para criar conta sem convite (primeira conta da instalação ou cadastro aberto). */
  async signupStatus(): Promise<{ open: boolean; firstAccount: boolean }> {
    return this.request("GET", "/auth/signup-status");
  }
  async login(email: string, password: string): Promise<UserDTO> {
    return unwrap<UserDTO>(await this.request("POST", "/auth/login", { email, password }), "user");
  }
  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout");
  }
  async me(): Promise<MeResponse> {
    const data = await this.request<MeResponse>("GET", "/me");
    return { user: data.user, workspaces: data.workspaces ?? [] };
  }
  async updateMe(patch: { name?: string; avatarColor?: string | null }): Promise<UserDTO> {
    return unwrap<UserDTO>(await this.request("PATCH", "/me", patch), "user");
  }
  async getInvite(code: string): Promise<{ workspaceName: string; valid: boolean }> {
    return this.request("GET", `/invites/${encodeURIComponent(code)}`);
  }
  async acceptInvite(code: string): Promise<WorkspaceDTO> {
    return unwrap<WorkspaceDTO>(
      await this.request("POST", `/invites/${encodeURIComponent(code)}/accept`),
      "workspace",
    );
  }

  // ---------- Workspace ----------
  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceDTO> {
    return unwrap<WorkspaceDTO>(await this.request("POST", "/workspaces", input), "workspace");
  }
  async updateWorkspace(
    ws: string,
    patch: { name?: string; business?: string | null; routerEnabled?: boolean },
  ): Promise<WorkspaceDTO> {
    return unwrap<WorkspaceDTO>(await this.request("PATCH", this.w(ws), patch), "workspace");
  }
  bootstrap(ws: string): Promise<BootstrapDTO> {
    return this.request("GET", this.w(ws, "/bootstrap"));
  }
  async listMembers(ws: string): Promise<MemberDTO[]> {
    return items(await this.request("GET", this.w(ws, "/members")));
  }
  async updateMember(
    ws: string,
    userId: string,
    patch: { role?: Role; title?: string | null; statusText?: string | null; sectorId?: string | null },
  ): Promise<MemberDTO> {
    return unwrap<MemberDTO>(await this.request("PATCH", this.w(ws, `/members/${userId}`), patch), "member");
  }
  async removeMember(ws: string, userId: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/members/${userId}`));
  }
  createInvite(ws: string, input: { role?: Role; maxUses?: number; expiresInDays?: number }): Promise<InviteCreatedDTO> {
    return this.request("POST", this.w(ws, "/invites"), input);
  }
  async listSectors(ws: string): Promise<SectorDTO[]> {
    return items(await this.request("GET", this.w(ws, "/sectors")));
  }
  async createSector(ws: string, input: { name: string; leadUserId?: string | null }): Promise<SectorDTO> {
    return unwrap<SectorDTO>(await this.request("POST", this.w(ws, "/sectors"), input), "sector");
  }
  async updateSector(ws: string, id: string, patch: { name?: string; leadUserId?: string | null }): Promise<SectorDTO> {
    return unwrap<SectorDTO>(await this.request("PATCH", this.w(ws, `/sectors/${id}`), patch), "sector");
  }
  async deleteSector(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/sectors/${id}`));
  }
  async search(ws: string, q: string): Promise<SearchResultsDTO> {
    const d = await this.request<Partial<SearchResultsDTO>>("GET", this.w(ws, "/search"), undefined, { q });
    return { messages: d.messages ?? [], tasks: d.tasks ?? [], wikiPages: d.wikiPages ?? [], files: d.files ?? [] };
  }

  // ---------- Tokens e runners ----------
  async listTokens(ws: string): Promise<ApiTokenDTO[]> {
    return items(await this.request("GET", this.w(ws, "/tokens")));
  }
  createToken(ws: string, input: { name: string; kind: "personal" | "runner" }): Promise<{ token: string }> {
    return this.request("POST", this.w(ws, "/tokens"), input);
  }
  async deleteToken(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/tokens/${id}`));
  }
  async listRunners(ws: string): Promise<RunnerDTO[]> {
    return items(await this.request("GET", this.w(ws, "/runners")));
  }
  async deleteRunner(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/runners/${id}`));
  }
  /** Devolve o nome que o computador informou (o hub só revela depois de aprovar). */
  async approvePairing(ws: string, pairCode: string): Promise<{ name: string | null }> {
    const d = await this.request<{ name?: unknown } | undefined>("POST", this.w(ws, "/runner/pair/approve"), { pairCode });
    return { name: typeof d?.name === "string" && d.name.trim() ? d.name : null };
  }

  // ---------- Canais e mensagens ----------
  async listChannels(ws: string): Promise<ChannelDTO[]> {
    return items(await this.request("GET", this.w(ws, "/channels")));
  }
  async createChannel(ws: string, input: CreateChannelInput): Promise<ChannelDTO> {
    return unwrap<ChannelDTO>(await this.request("POST", this.w(ws, "/channels"), input), "channel");
  }
  async updateChannel(
    ws: string,
    id: string,
    patch: Partial<Pick<ChannelDTO, "name" | "section" | "topic" | "humansOnly" | "isPrivate">>,
  ): Promise<ChannelDTO> {
    return unwrap<ChannelDTO>(await this.request("PATCH", this.w(ws, `/channels/${id}`), patch), "channel");
  }
  async deleteChannel(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/channels/${id}`));
  }
  async addChannelMember(ws: string, id: string, member: ActorRef): Promise<void> {
    await this.request("POST", this.w(ws, `/channels/${id}/members`), { member });
  }
  async removeChannelMember(ws: string, id: string, member: ActorRef): Promise<void> {
    await this.request("DELETE", this.w(ws, `/channels/${id}/members`), { member });
  }
  async openDm(ws: string, withActor: ActorRef): Promise<ChannelDTO> {
    return unwrap<ChannelDTO>(await this.request("POST", this.w(ws, "/dms"), { with: withActor }), "channel");
  }
  async listMessages(ws: string, channelId: string, q: ListMessagesQuery = {}): Promise<MessageDTO[]> {
    return items(
      await this.request("GET", this.w(ws, `/channels/${channelId}/messages`), undefined, {
        before: q.before,
        limit: q.limit,
        threadRootId: q.threadRootId,
        pinned: q.pinned,
      }),
    );
  }
  async sendMessage(ws: string, channelId: string, input: SendMessageInput): Promise<MessageDTO> {
    return unwrap<MessageDTO>(
      await this.request("POST", this.w(ws, `/channels/${channelId}/messages`), input),
      "message",
    );
  }
  async editMessage(ws: string, id: string, body: string): Promise<MessageDTO> {
    return unwrap<MessageDTO>(await this.request("PATCH", this.w(ws, `/messages/${id}`), { body }), "message");
  }
  async setPinned(ws: string, id: string, pinned: boolean): Promise<MessageDTO> {
    return unwrap<MessageDTO>(await this.request("PATCH", this.w(ws, `/messages/${id}`), { pinned }), "message");
  }
  async deleteMessage(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/messages/${id}`));
  }
  async addReaction(ws: string, id: string, emoji: string): Promise<void> {
    await this.request("POST", this.w(ws, `/messages/${id}/reactions`), { emoji });
  }
  async removeReaction(ws: string, id: string, emoji: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/messages/${id}/reactions`), { emoji });
  }
  async markRead(ws: string, channelId: string): Promise<void> {
    await this.request("POST", this.w(ws, `/channels/${channelId}/read`));
  }

  async getMessage(ws: string, id: string): Promise<MessageDTO> {
    return unwrap<MessageDTO>(await this.request("GET", this.w(ws, `/messages/${id}`)), "message");
  }
  /** Cria o time inicial a partir do ramo do workspace. */
  async createStarterTeam(ws: string, input: { business?: string | null } = {}): Promise<StarterTeamResponse> {
    const d = await this.request<Partial<StarterTeamResponse> | undefined>("POST", this.w(ws, "/starter-team"), input);
    const agents = d?.agents ?? [];
    const channels = d?.channels ?? [];
    return {
      template: d?.template ?? "generico",
      agents,
      channels,
      createdAgents: d?.createdAgents ?? agents.length,
      createdChannels: d?.createdChannels ?? channels.length,
    };
  }

  // ---------- Tarefas ----------
  async listTasks(ws: string, q: TaskQuery = {}): Promise<TaskDTO[]> {
    return items(await this.request("GET", this.w(ws, "/tasks"), undefined, { ...q }));
  }
  async createTask(ws: string, input: CreateTaskInput): Promise<TaskDTO> {
    return unwrap<TaskDTO>(await this.request("POST", this.w(ws, "/tasks"), input), "task");
  }
  async getTask(ws: string, id: string): Promise<TaskDTO> {
    return unwrap<TaskDTO>(await this.request("GET", this.w(ws, `/tasks/${id}`)), "task");
  }
  async updateTask(ws: string, id: string, patch: TaskPatch): Promise<TaskDTO> {
    return unwrap<TaskDTO>(await this.request("PATCH", this.w(ws, `/tasks/${id}`), patch), "task");
  }
  async deleteTask(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/tasks/${id}`));
  }
  async listTaskComments(ws: string, id: string): Promise<TaskCommentDTO[]> {
    return items(await this.request("GET", this.w(ws, `/tasks/${id}/comments`)));
  }
  async addTaskComment(ws: string, id: string, body: string): Promise<TaskCommentDTO> {
    return unwrap<TaskCommentDTO>(await this.request("POST", this.w(ws, `/tasks/${id}/comments`), { body }), "comment");
  }
  /** "Continuar todas": devolve quantos trabalhos foram criados, quando o hub informa. */
  async resumeStalledTasks(ws: string): Promise<{ count: number | null }> {
    const d = await this.request<Record<string, unknown> | undefined>("POST", this.w(ws, "/tasks/resume-stalled"));
    // O hub responde `{ stalled, items: JobDTO[] }` (trabalhos criados).
    const n = d?.count ?? d?.resumed ?? (Array.isArray(d?.items) ? (d!.items as unknown[]).length : Array.isArray(d?.jobs) ? (d!.jobs as unknown[]).length : undefined);
    return { count: typeof n === "number" ? n : null };
  }

  // ---------- Wiki ----------
  async listWiki(ws: string, opts: { trash?: boolean } = {}): Promise<WikiPageDTO[]> {
    return items(await this.request("GET", this.w(ws, "/wiki"), undefined, { trash: opts.trash }));
  }
  async createWikiPage(
    ws: string,
    input: { title: string; body?: string; parentId?: string | null; isFolder?: boolean },
  ): Promise<WikiPageDTO> {
    return unwrap<WikiPageDTO>(await this.request("POST", this.w(ws, "/wiki"), input), "page");
  }
  async getWikiPage(ws: string, id: string): Promise<WikiPageDTO> {
    return unwrap<WikiPageDTO>(await this.request("GET", this.w(ws, `/wiki/${id}`)), "page");
  }
  /** 409 (`ApiClientError.status`) quando `baseVersion` está desatualizada. */
  async updateWikiPage(ws: string, id: string, patch: WikiPatch): Promise<WikiPageDTO> {
    return unwrap<WikiPageDTO>(await this.request("PATCH", this.w(ws, `/wiki/${id}`), patch), "page");
  }
  async deleteWikiPage(ws: string, id: string, opts: { permanent?: boolean } = {}): Promise<void> {
    await this.request("DELETE", this.w(ws, `/wiki/${id}`), undefined, { permanent: opts.permanent });
  }
  async restoreWikiPage(ws: string, id: string): Promise<WikiPageDTO | undefined> {
    const d = await this.request("POST", this.w(ws, `/wiki/${id}/restore`));
    return d ? unwrap<WikiPageDTO>(d, "page") : undefined;
  }
  async listWikiRevisions(ws: string, id: string): Promise<WikiRevisionDTO[]> {
    return items(await this.request("GET", this.w(ws, `/wiki/${id}/revisions`)));
  }
  async getWikiStats(ws: string, id: string): Promise<WikiStatsDTO> {
    const d = await this.request<Partial<WikiStatsDTO>>("GET", this.w(ws, `/wiki/${id}/stats`));
    return { readsThisWeek: d.readsThisWeek ?? 0, readers: d.readers ?? [], mentionedIn: d.mentionedIn ?? [] };
  }
  async getWikiGraph(ws: string): Promise<WikiGraphDTO> {
    const d = await this.request<Partial<WikiGraphDTO>>("GET", this.w(ws, "/wiki-graph"));
    return { nodes: d.nodes ?? [], edges: d.edges ?? [] };
  }

  // ---------- Drive ----------
  async listFiles(ws: string, q: { folder?: string; q?: string } = {}): Promise<FileDTO[]> {
    return items(await this.request("GET", this.w(ws, "/files"), undefined, q));
  }
  async updateFile(ws: string, id: string, patch: { name?: string; folder?: string | null }): Promise<FileDTO> {
    return unwrap<FileDTO>(await this.request("PATCH", this.w(ws, `/files/${id}`), patch), "file");
  }
  async deleteFile(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/files/${id}`));
  }

  // ---------- Rotinas ----------
  async listRoutines(ws: string, q: { agentId?: string } = {}): Promise<RoutineDTO[]> {
    return items(await this.request("GET", this.w(ws, "/routines"), undefined, q));
  }
  async createRoutine(ws: string, input: RoutineInput): Promise<RoutineDTO> {
    return unwrap<RoutineDTO>(await this.request("POST", this.w(ws, "/routines"), input), "routine");
  }
  async updateRoutine(ws: string, id: string, patch: Partial<RoutineInput>): Promise<RoutineDTO> {
    return unwrap<RoutineDTO>(await this.request("PATCH", this.w(ws, `/routines/${id}`), patch), "routine");
  }
  async deleteRoutine(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/routines/${id}`));
  }
  /** `skipped`: motivo de não ter rodado (`agent_paused`, `budget`, `no_channel`, `agent_missing`). */
  async runRoutine(ws: string, id: string): Promise<{ kind: string | null; job: JobDTO | null; messageId: string | null; skipped: string | null }> {
    const d = await this.request<Record<string, unknown> | undefined>("POST", this.w(ws, `/routines/${id}/run`));
    return {
      kind: typeof d?.kind === "string" ? d.kind : null,
      job: (d?.job as JobDTO | null | undefined) ?? null,
      messageId: typeof d?.messageId === "string" ? d.messageId : null,
      skipped: typeof d?.skipped === "string" ? d.skipped : null,
    };
  }

  // ---------- Skills e conectores ----------
  async createSkill(ws: string, input: SkillInput): Promise<SkillDTO> {
    return unwrap<SkillDTO>(await this.request("POST", this.w(ws, "/skills"), input), "skill");
  }
  async updateSkill(ws: string, id: string, patch: Partial<SkillInput>): Promise<SkillDTO> {
    return unwrap<SkillDTO>(await this.request("PATCH", this.w(ws, `/skills/${id}`), patch), "skill");
  }
  async deleteSkill(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/skills/${id}`));
  }
  async createConnector(ws: string, input: ConnectorInput): Promise<ConnectorDTO> {
    return unwrap<ConnectorDTO>(await this.request("POST", this.w(ws, "/connectors"), input), "connector");
  }
  async updateConnector(ws: string, id: string, patch: Partial<ConnectorInput>): Promise<ConnectorDTO> {
    return unwrap<ConnectorDTO>(await this.request("PATCH", this.w(ws, `/connectors/${id}`), patch), "connector");
  }
  async deleteConnector(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/connectors/${id}`));
  }

  // ---------- Catálogo e login de conectores ----------
  async getCatalog(ws: string): Promise<{ items: CatalogApp[]; callbackUrl: string }> {
    const d = await this.request<{ items?: CatalogApp[]; callbackUrl?: string }>("GET", this.w(ws, "/connectors/catalog"));
    return { items: d?.items ?? [], callbackUrl: d?.callbackUrl ?? "" };
  }
  async connectFromCatalog(ws: string, input: CatalogConnectInput): Promise<ConnectorDTO> {
    return unwrap<ConnectorDTO>(await this.request("POST", this.w(ws, "/connectors/from-catalog"), input), "connector");
  }
  /** Endereço da tela de consentimento do serviço; a interface manda o navegador para lá. */
  startConnectorOAuth(ws: string, id: string): Promise<{ url: string }> {
    return this.request("POST", this.w(ws, `/connectors/${id}/oauth/start`));
  }
  async grantConnector(ws: string, id: string, agentIds: string[]): Promise<void> {
    await this.request("POST", this.w(ws, `/connectors/${id}/grant`), { agentIds });
  }

  // ---------- Agente criador ----------
  openSetupSession(ws: string): Promise<SetupSessionDTO> {
    return this.request("POST", this.w(ws, "/setup/session"));
  }
  async getSetupPlan(ws: string): Promise<SetupPlanDTO | null> {
    return (await this.request<{ plan: SetupPlanDTO | null }>("GET", this.w(ws, "/setup/plan")))?.plan ?? null;
  }
  updateSetupPlan(ws: string, id: string, plan: SetupPlan): Promise<SetupPlanDTO> {
    return this.request("PUT", this.w(ws, `/setup/plans/${id}`), plan);
  }
  applySetupPlan(ws: string, id: string): Promise<SetupPlanDTO> {
    return this.request("POST", this.w(ws, `/setup/plans/${id}/apply`));
  }
  async discardSetupPlan(ws: string, id: string): Promise<void> {
    await this.request("POST", this.w(ws, `/setup/plans/${id}/discard`));
  }

  // ---------- Regras de permissão e uso ----------
  async listTrustRules(ws: string, agentId: string): Promise<TrustRuleDTO[]> {
    return items(await this.request("GET", this.w(ws, `/agents/${agentId}/trust-rules`)));
  }
  setTrustRule(ws: string, agentId: string, rule: { connectorId: string; tool?: string; effect: TrustRuleDTO["effect"] }): Promise<TrustRuleDTO> {
    return this.request("PUT", this.w(ws, `/agents/${agentId}/trust-rules`), rule);
  }
  async deleteTrustRule(ws: string, agentId: string, ruleId: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/agents/${agentId}/trust-rules/${ruleId}`));
  }
  async listUsage(ws: string, q: { period?: string; agentId?: string; before?: number; limit?: number } = {}): Promise<{ items: UsageEntryDTO[]; nextBefore: number | null }> {
    const d = await this.request<{ items?: UsageEntryDTO[]; nextBefore?: number | null }>("GET", this.w(ws, "/usage"), undefined, q);
    return { items: d?.items ?? [], nextBefore: d?.nextBefore ?? null };
  }
  getUsageSummary(ws: string, q: { period?: string; agentId?: string } = {}): Promise<UsageSummaryDTO> {
    return this.request("GET", this.w(ws, "/usage/summary"), undefined, q);
  }
  usageExportUrl(ws: string, period?: string): string {
    return `${this.baseUrl}/api${this.w(ws, "/usage/export")}${qs({ period })}`;
  }

  // ---------- Preparação automática ----------
  async setProactive(ws: string, agentId: string, input: { enabled: boolean; cron?: string; timezone?: string }): Promise<RoutineDTO | null> {
    return (await this.request<{ routine: RoutineDTO | null }>("PUT", this.w(ws, `/agents/${agentId}/proactive`), input))?.routine ?? null;
  }

  // ---------- Canais de conversa, cofre e voz ----------
  async getFeatures(ws: string): Promise<HubFeatures> {
    try {
      return { ...NO_FEATURES, ...(await this.request<Partial<HubFeatures>>("GET", this.w(ws, "/features"))) };
    } catch (err) {
      // Hub antigo (ou modo demonstração) sem a rota: nada ligado.
      if (err instanceof ApiClientError && err.status === 404) return NO_FEATURES;
      throw err;
    }
  }
  async listChatLinks(ws: string): Promise<ChatLinkDTO[]> {
    return items(await this.request("GET", this.w(ws, "/chat-links")));
  }
  createChatLink(ws: string, provider: ChatLinkDTO["provider"], agentId: string): Promise<ChatLinkDTO> {
    return this.request("POST", this.w(ws, "/chat-links"), { provider, agentId });
  }
  async deleteChatLink(ws: string, provider: ChatLinkDTO["provider"]): Promise<void> {
    await this.request("DELETE", this.w(ws, `/chat-links/${provider}`));
  }
  async listVault(ws: string): Promise<VaultItemDTO[]> {
    return items(await this.request("GET", this.w(ws, "/vault")));
  }
  createVaultItem(ws: string, input: VaultInput): Promise<VaultItemDTO> {
    return this.request("POST", this.w(ws, "/vault"), input);
  }
  updateVaultItem(ws: string, id: string, patch: Partial<VaultInput>): Promise<VaultItemDTO> {
    return this.request("PATCH", this.w(ws, `/vault/${id}`), patch);
  }
  async deleteVaultItem(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/vault/${id}`));
  }
  /** Transcreve um áudio curto gravado no navegador (precisa de `features.transcription`). */
  async transcribe(ws: string, audio: Blob): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/api${this.w(ws, "/transcribe")}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": audio.type || "audio/webm" },
      body: audio,
    });
    const data = (await res.json().catch(() => null)) as { text?: string; error?: { code?: string; message?: string } } | null;
    if (!res.ok) throw new ApiClientError(res.status, data?.error?.code ?? `http_${res.status}`, data?.error?.message ?? defaultMessage(res.status));
    return data?.text ?? "";
  }

  // ---------- Push e Telegram ----------
  /** Chave VAPID pública, ou null se o hub não tiver push configurado (404). */
  async getPushPublicKey(): Promise<string | null> {
    try {
      const d = await this.request<{ key?: string; publicKey?: string }>("GET", "/push/public-key");
      return d?.key ?? d?.publicKey ?? null;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) return null;
      throw err;
    }
  }
  async subscribePush(sub: PushSubscriptionInput): Promise<void> {
    await this.request("POST", "/push/subscriptions", sub);
  }
  async unsubscribePush(endpoint: string): Promise<void> {
    await this.request("DELETE", "/push/subscriptions", { endpoint });
  }
  /** null quando o Telegram não está configurado no hub (404). */
  async getTelegramLink(): Promise<TelegramLinkDTO | null> {
    try {
      return await this.request<TelegramLinkDTO>("GET", "/telegram/link");
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) return null;
      throw err;
    }
  }
  createTelegramLink(): Promise<TelegramLinkDTO> {
    return this.request("POST", "/telegram/link");
  }
  async deleteTelegramLink(): Promise<void> {
    await this.request("DELETE", "/telegram/link");
  }

  // ---------- Agentes ----------
  async listAgents(ws: string): Promise<AgentDTO[]> {
    return items(await this.request("GET", this.w(ws, "/agents")));
  }
  async createAgent(ws: string, input: CreateAgentInput): Promise<AgentDTO> {
    return unwrap<AgentDTO>(await this.request("POST", this.w(ws, "/agents"), input), "agent");
  }
  async getAgent(ws: string, id: string): Promise<AgentDTO> {
    return unwrap<AgentDTO>(await this.request("GET", this.w(ws, `/agents/${id}`)), "agent");
  }
  async updateAgent(ws: string, id: string, patch: AgentPatch): Promise<AgentDTO> {
    return unwrap<AgentDTO>(await this.request("PATCH", this.w(ws, `/agents/${id}`), patch), "agent");
  }
  async deleteAgent(ws: string, id: string): Promise<void> {
    await this.request("DELETE", this.w(ws, `/agents/${id}`));
  }
  getAgentUsage(ws: string, id: string, period?: string): Promise<AgentUsageDTO> {
    return this.request("GET", this.w(ws, `/agents/${id}/usage`), undefined, { period });
  }
  async getAgentActivity(ws: string, id: string): Promise<ActivityItem[]> {
    return items(await this.request("GET", this.w(ws, `/agents/${id}/activity`)));
  }
  /** `agentId` nulo = memória do time. */
  async listMemories(ws: string, agentId: string | null): Promise<MemoryDTO[]> {
    return items(await this.request("GET", this.memoryPath(ws, agentId)));
  }
  async createMemory(ws: string, agentId: string | null, content: string): Promise<MemoryDTO> {
    return unwrap<MemoryDTO>(await this.request("POST", this.memoryPath(ws, agentId), { content }), "memory");
  }
  async updateMemory(ws: string, agentId: string | null, id: string, content: string): Promise<MemoryDTO> {
    return unwrap<MemoryDTO>(
      await this.request("PATCH", this.memoryPath(ws, agentId, id), { content }),
      "memory",
    );
  }
  /** Confirma uma memória que um agente gravou sem citação conferida. */
  async confirmMemory(ws: string, agentId: string | null, id: string): Promise<MemoryDTO> {
    return unwrap<MemoryDTO>(await this.request("POST", `${this.memoryPath(ws, agentId, id)}/confirm`), "memory");
  }
  async deleteMemory(ws: string, agentId: string | null, id: string): Promise<void> {
    await this.request("DELETE", this.memoryPath(ws, agentId, id));
  }
  private memoryPath(ws: string, agentId: string | null, id?: string): string {
    const base = agentId ? `/agents/${agentId}/memories` : "/memories";
    return this.w(ws, id ? `${base}/${id}` : base);
  }
  async listConnectors(ws: string): Promise<ConnectorDTO[]> {
    return items(await this.request("GET", this.w(ws, "/connectors")));
  }
  async listSkills(ws: string): Promise<SkillDTO[]> {
    return items(await this.request("GET", this.w(ws, "/skills")));
  }

  // ---------- Jobs e aprovações ----------
  async listJobs(ws: string, q: { status?: string; agentId?: string; channelId?: string } = {}): Promise<JobDTO[]> {
    return items(await this.request("GET", this.w(ws, "/jobs"), undefined, q));
  }
  async cancelJob(ws: string, id: string): Promise<void> {
    await this.request("POST", this.w(ws, `/jobs/${id}/cancel`));
  }
  async retryJob(ws: string, id: string): Promise<void> {
    await this.request("POST", this.w(ws, `/jobs/${id}/retry`));
  }
  async listApprovals(ws: string, status?: ApprovalDTO["status"]): Promise<ApprovalDTO[]> {
    return items(await this.request("GET", this.w(ws, "/approvals"), undefined, { status }));
  }
  async decideApproval(
    ws: string,
    id: string,
    decision: "approved" | "rejected",
    note?: string,
    /** Só em aprovação de ação: vale só esta vez, até o fim do trabalho, ou sempre. */
    scope?: "once" | "job" | "always",
  ): Promise<ApprovalDTO | undefined> {
    const d = await this.request("POST", this.w(ws, `/approvals/${id}/decide`), { decision, note: note || undefined, ...(scope ? { scope } : {}) });
    return d ? unwrap<ApprovalDTO>(d, "approval") : undefined;
  }
  /** Responde um pedido de segredo. O valor vai só nesta requisição; a resposta não o traz de volta. */
  async answerSecretRequest(ws: string, id: string, answer: { secret: string; username?: string } | null): Promise<ApprovalDTO | undefined> {
    const d = await this.request(
      "POST",
      this.w(ws, `/approvals/${id}/decide`),
      answer ? { decision: "approved", secret: answer.secret, ...(answer.username ? { username: answer.username } : {}) } : { decision: "rejected" },
    );
    return d ? unwrap<ApprovalDTO>(d, "approval") : undefined;
  }

  // ---------- Arquivos ----------
  async uploadFile(
    ws: string,
    file: File,
    opts: { channelId?: string; folder?: string; inDrive?: boolean } = {},
  ): Promise<FileDTO> {
    const form = new FormData();
    form.set("file", file);
    if (opts.channelId) form.set("channelId", opts.channelId);
    if (opts.folder) form.set("folder", opts.folder);
    if (opts.inDrive !== undefined) form.set("inDrive", opts.inDrive ? "1" : "0");
    return unwrap<FileDTO>(await this.request("POST", this.w(ws, "/files"), form), "file");
  }
  /**
   * Endereço do conteúdo do arquivo. `inline`: abre no navegador (imagem, PDF, texto, áudio e vídeo;
   * o hub força download nos outros tipos) e pode ser mostrado num <iframe> da interface.
   */
  fileUrl(ws: string, fileId: string, opts: { inline?: boolean } = {}): string {
    if (this.fileUrlImpl) return this.fileUrlImpl(ws, fileId);
    return `${this.baseUrl}/api${this.w(ws, `/files/${fileId}/content`)}${opts.inline ? "?inline=1" : ""}`;
  }

  // ---------- Notificações ----------
  async listNotifications(ws: string): Promise<NotificationDTO[]> {
    return items(await this.request("GET", this.w(ws, "/notifications")));
  }
  /** Notificações de todos os workspaces (usado pelo service worker). */
  async listMyNotifications(): Promise<MyNotificationDTO[]> {
    return items(await this.request("GET", "/me/notifications"));
  }
  async markNotificationsRead(ws: string, ids?: string[]): Promise<void> {
    await this.request("POST", this.w(ws, "/notifications/read"), { ids: ids ?? [] });
  }

  // ---------- Tempo real ----------
  realtimeUrl(ws: string): string {
    const base = this.baseUrl || (typeof location !== "undefined" ? location.origin : "http://localhost");
    const url = new URL(`${base}/api${this.w(ws, "/realtime")}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
}

function defaultMessage(status: number): string {
  if (status === 401) return "Sua sessão expirou. Entre de novo.";
  if (status === 403) return "Você não tem permissão para fazer isso.";
  if (status === 404) return "Não encontrado.";
  if (status === 409) return "Alguém mudou isso ao mesmo tempo. Recarregue e tente de novo.";
  if (status === 411) return "O tamanho do envio não foi informado. Tente de novo.";
  if (status === 413) return "O envio é grande demais.";
  if (status === 429) return "Muitas tentativas. Espere um pouco.";
  if (status >= 500) return "O servidor teve um problema. Tente de novo em instantes.";
  return "Não foi possível concluir.";
}
