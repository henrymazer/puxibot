/** Dados fictícios do modo demonstração. */
import type { AgentDTO, ChannelDTO, MessageDTO, NativeTool, ToolLevel } from "@puxibot/shared";
import type { DemoDb } from "./backend";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function seed(): DemoDb {
  const now = Date.now();
  const U = { ana: "usr_ana", bruno: "usr_bruno", carla: "usr_carla", diego: "usr_diego" };
  const A = { tito: "agt_theo", lia: "agt_lia", nina: "agt_nina", assist: "agt_assist" };

  const perms = (lvl: ToolLevel): Record<string, ToolLevel> =>
    Object.fromEntries((["messages", "memory", "tasks", "wiki", "drive", "agents"] as NativeTool[]).map((t) => [t, lvl]));

  const baseAgent = (p: Partial<AgentDTO> & Pick<AgentDTO, "id" | "handle" | "name">): AgentDTO => ({
    role: null,
    description: null,
    instructions: "",
    avatarColor: null,
    avatarAccessory: null,
    sectorId: null,
    ownerUserId: U.ana,
    isAssistant: false,
    accessMode: "workspace",
    allowedUserIds: [],
    agentsCanConsult: true,
    callableAgentsMode: "all",
    callableAgentIds: [],
    preferredCli: null,
    preferredModel: null,
    budgetTokensMonth: 2_000_000,
    budgetRunsMonth: 200,
    selfStartPolicy: "ask",
    maxConcurrentJobs: 2,
    maxPrsPerHour: 3,
    status: "active",
    toolPerms: perms("write"),
    skillIds: [],
    activity: "idle",
    createdAt: now - 30 * DAY,
    updatedAt: now - 2 * DAY,
    ...p,
  });

  const agents: AgentDTO[] = [
    baseAgent({
      id: A.tito,
      handle: "tito",
      name: "Tito",
      role: "Engenharia",
      description: "Cuida do código, revisa PRs e acompanha deploys.",
      instructions:
        "Você é o Tito, engenheiro do time.\n\n- Responda de forma curta e objetiva.\n- Antes de mudar código, explique o plano.\n- Sempre rode os testes antes de abrir um PR.",
      avatarColor: "#3f7d6e",
      avatarAccessory: "headset",
      sectorId: "sec_tech",
      preferredCli: "claude",
      toolPerms: { ...perms("write"), "connector:con_github": "write" },
    }),
    baseAgent({
      id: A.lia,
      handle: "lia",
      name: "Lia",
      role: "Marketing",
      description: "Escreve campanhas, newsletter e posts.",
      instructions: "Você é a Lia, do marketing. Tom leve, frases curtas.",
      avatarColor: "#c2683f",
      avatarAccessory: "star",
      sectorId: "sec_mkt",
      ownerUserId: U.bruno,
      accessMode: "restricted",
      allowedUserIds: [U.ana, U.bruno],
      activity: "working",
      budgetRunsMonth: 50,
    }),
    baseAgent({
      id: A.nina,
      handle: "nina",
      name: "Nina",
      role: "Finanças",
      description: "Fecha o caixa e prepara relatórios mensais.",
      avatarColor: "#6a5fa8",
      avatarAccessory: "glasses",
      sectorId: "sec_fin",
      ownerUserId: U.carla,
      status: "paused",
      selfStartPolicy: "run",
      toolPerms: { ...perms("read"), agents: "none" },
    }),
    baseAgent({
      id: A.assist,
      handle: "assistente-ana",
      name: "Assistente da Ana",
      role: "Assistente pessoal",
      description: "Lembra prazos, manda recados e faz o resumo do dia.",
      avatarColor: "#8a7a3a",
      avatarAccessory: "antenna",
      isAssistant: true,
      accessMode: "owner",
      budgetRunsMonth: null,
      budgetTokensMonth: null,
    }),
  ];

  const ch = (p: Partial<ChannelDTO> & Pick<ChannelDTO, "id" | "name">): ChannelDTO => ({
    kind: "channel",
    section: null,
    topic: null,
    humansOnly: false,
    isPrivate: false,
    members: [
      { type: "user", id: U.ana },
      { type: "user", id: U.bruno },
      { type: "user", id: U.carla },
      { type: "user", id: U.diego },
    ],
    unread: 0,
    lastMessageAt: null,
    ...p,
  });
  const people = (ids: string[]) => ids.map((id) => ({ type: "user" as const, id }));

  const channels: ChannelDTO[] = [
    ch({ id: "ch_geral", name: "geral", topic: "Avisos e conversa do time inteiro", members: [...people([U.ana, U.bruno, U.carla, U.diego]), { type: "agent", id: A.tito }, { type: "agent", id: A.lia }] }),
    ch({ id: "ch_dev", name: "dev", section: "Tech", topic: "Código, PRs e deploys", unread: 3, members: [...people([U.ana, U.bruno, U.diego]), { type: "agent", id: A.tito }] }),
    ch({ id: "ch_deploys", name: "deploys", section: "Tech", topic: "Avisos automáticos de deploy" }),
    ch({ id: "ch_campanhas", name: "campanhas", section: "Marketing", unread: 1, members: [...people([U.ana, U.bruno]), { type: "agent", id: A.lia }] }),
    ch({ id: "ch_roadmap", name: "roadmap", section: "Produto", topic: "Prioridades do trimestre" }),
    ch({ id: "ch_cafe", name: "cafe", humansOnly: true, topic: "Só gente. Sem agentes por aqui." }),
    ch({ id: "ch_diretoria", name: "diretoria", isPrivate: true, members: people([U.ana, U.bruno]) }),
    ch({ id: "ch_feedbacks", name: "feedbacks", section: "Produto" }),
    { id: "dm_theo", kind: "dm", name: null, section: null, topic: null, humansOnly: false, isPrivate: true, members: [{ type: "user", id: U.ana }, { type: "agent", id: A.tito }], unread: 0, lastMessageAt: now - 3 * HOUR },
    { id: "dm_assist", kind: "dm", name: null, section: null, topic: null, humansOnly: false, isPrivate: true, members: [{ type: "user", id: U.ana }, { type: "agent", id: A.assist }], unread: 1, lastMessageAt: now - 5 * HOUR },
    { id: "dm_bruno", kind: "dm", name: null, section: null, topic: null, humansOnly: true, isPrivate: true, members: people([U.ana, U.bruno]), unread: 2, lastMessageAt: now - 20 * MIN },
  ];

  let n = 0;
  const msg = (p: Partial<MessageDTO> & Pick<MessageDTO, "channelId" | "author" | "body" | "createdAt">): MessageDTO => ({
    id: `msg_seed_${n++}`,
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
    ...p,
  });
  const u = (id: string) => ({ type: "user" as const, id });
  const ag = (id: string) => ({ type: "agent" as const, id });

  const messages: MessageDTO[] = [];
  // Histórico longo em #geral para testar o carregamento ao rolar.
  const lines = [
    "Bom dia, pessoal!",
    "Alguém viu o e-mail do cliente sobre o prazo?",
    "Vi sim, respondo até o almoço.",
    "Reunião de alinhamento às 15h, ok?",
    "Fechado.",
    "Subi a apresentação no drive.",
    "Valeu! Dou uma olhada agora.",
    "Lembrete: sexta é dia de retrospectiva.",
  ];
  const ppl = [U.bruno, U.carla, U.diego, U.ana];
  for (let i = 0; i < 90; i++) {
    const t = now - 14 * DAY + i * 3 * HOUR + (i % 3) * MIN;
    messages.push(msg({ channelId: "ch_geral", author: u(ppl[Math.floor(i / 2) % 4]!), body: lines[i % lines.length]!, createdAt: t }));
  }
  messages.push(
    msg({ channelId: "ch_geral", author: u(U.bruno), body: "Pessoal, **semana que vem** começamos a usar o Puxibot de verdade. Qualquer dúvida, chamem o @tito ou a @lia.", createdAt: now - 26 * HOUR, pinned: true, mentions: [ag(A.tito), ag(A.lia)], reactions: [{ emoji: "🎉", userIds: [U.ana, U.carla] }] }),
    msg({ channelId: "ch_geral", author: u(U.carla), body: "Show! Já deixei a Nina pausada até fecharmos o orçamento.", createdAt: now - 25 * HOUR }),
  );

  // #dev com agente, thread, cartões e marcador de novas.
  const devRoot = msg({
    channelId: "ch_dev",
    author: ag(A.tito),
    body: "Resumo dos PRs de hoje:\n\n| PR | Autor | Estado |\n|---|---|---|\n| #128 | Diego | aguardando revisão |\n| #131 | Tito | testes passando |\n\nO `#131` corrige o bug do login no Safari.",
    createdAt: now - 4 * HOUR,
    jobId: "job_seed_1",
    meta: { cli: "claude", model: "Opus 5.5", runnerUserId: U.bruno, runnerName: "Bruno" },
    replyCount: 2,
    reactions: [{ emoji: "👍", userIds: [U.ana] }],
  });
  messages.push(
    msg({ channelId: "ch_dev", author: u(U.diego), body: "@tito pode resumir os PRs abertos?", createdAt: now - 4 * HOUR - 2 * MIN, mentions: [ag(A.tito)] }),
    devRoot,
    msg({ channelId: "ch_dev", author: u(U.ana), body: "Ótimo. Eu reviso o #128 depois do almoço.", createdAt: now - 4 * HOUR + 1 * MIN, threadRootId: devRoot.id }),
    msg({ channelId: "ch_dev", author: ag(A.tito), body: "Combinado. Deixei dois comentários lá sobre nomes de variáveis.", createdAt: now - 4 * HOUR + 3 * MIN, threadRootId: devRoot.id, meta: { cli: "claude", model: "Opus 5.5", runnerUserId: U.ana, runnerName: "Ana" } }),
    msg({ channelId: "ch_dev", author: u(U.ana), body: "Subi o print do erro que apareceu ontem.", createdAt: now - 3 * HOUR, attachments: [{ fileId: "file_seed_log", name: "erro-safari.log", mime: "text/plain", size: 18_432 }] }),
    msg({ channelId: "ch_dev", author: u(U.bruno), body: "Deploy das 14h passou. 🚀", createdAt: now - 50 * MIN }),
    msg({ channelId: "ch_dev", author: u(U.diego), body: "Boa! Alguém olha o alerta de memória do worker?", createdAt: now - 40 * MIN }),
    msg({
      channelId: "ch_dev",
      author: ag(A.tito),
      body: "Olhei o alerta. Era um pico durante o build, já voltou ao normal.",
      createdAt: now - 35 * MIN,
      jobId: "job_seed_2",
      meta: { cli: "codex", model: "GPT-5.3", runnerUserId: U.diego, runnerName: "Diego" },
      cards: [
        { type: "stats", title: "Worker nas últimas 24 h", items: [{ label: "Requisições", value: "182 mil" }, { label: "Erros", value: "0,02%" }, { label: "CPU média", value: "3,1 ms" }] },
        { type: "checklist", title: "Pra eu começar", items: [{ label: "Conferir limites do plano", done: true }, { label: "Ajustar alerta para 85%", done: false }, { label: "Documentar na wiki", done: false, link: "https://example.com" }] },
      ],
    }),
  );

  messages.push(
    msg({ channelId: "ch_campanhas", author: ag(A.lia), body: "Rascunho da newsletter de dezembro pronto. Prefiro o título **\"Fim de ano sem correria\"**.", createdAt: now - 2 * HOUR, meta: { cli: "gemini", model: "Gemini 3 Pro", runnerUserId: U.bruno, runnerName: "Bruno" }, jobId: "job_seed_3",
      cards: [{ type: "bars", title: "Abertura das últimas newsletters", subtitle: "Taxa de abertura", rows: [{ label: "Setembro", value: 31, display: "31%" }, { label: "Outubro", value: 38, display: "38%" }, { label: "Novembro", value: 44, display: "44%" }] }] }),
    msg({ channelId: "dm_theo", author: u(U.ana), body: "Tito, me lembra de revisar o contrato da API amanhã?", createdAt: now - 3 * HOUR - 5 * MIN }),
    msg({ channelId: "dm_theo", author: ag(A.tito), body: "Anotado. Amanhã às 9h te mando o lembrete aqui.", createdAt: now - 3 * HOUR, meta: { cli: "claude", model: "Opus 5.5", runnerUserId: U.ana, runnerName: "Ana" }, jobId: "job_seed_4" }),
    msg({ channelId: "dm_assist", author: ag(A.assist), body: "**Resumo do dia**\n\n- Feito: 3 tarefas\n- Travado: deploy do app mobile\n- Esperando você: 1 aprovação do Tito", createdAt: now - 5 * HOUR, meta: { cli: "claude", model: "Sonnet 5", runnerUserId: U.ana, runnerName: "Ana" } }),
    msg({ channelId: "dm_bruno", author: u(U.bruno), body: "Ana, consegue ver o orçamento da Lia hoje?", createdAt: now - 25 * MIN }),
    msg({ channelId: "dm_bruno", author: u(U.bruno), body: "Ela está chegando perto do limite.", createdAt: now - 20 * MIN }),
    msg({ channelId: "ch_cafe", author: u(U.carla), body: "Quem traz o bolo na sexta? 🍰", createdAt: now - 6 * HOUR }),
  );
  for (const c of channels) {
    const last = messages.filter((m) => m.channelId === c.id).at(-1);
    if (last) c.lastMessageAt = last.createdAt;
  }

  return {
    user: { id: U.ana, email: "ana@estudio-aurora.example", name: "Ana Ribeiro", avatarColor: "#3f6fa8" },
    loggedIn: !new URLSearchParams(location.search).has("anon"),
    workspaces: [
      { id: "ws_aurora", name: "Estúdio Aurora", kind: "team", business: "Agência de software", routerEnabled: false, role: "owner" },
      { id: "ws_pessoal", name: "Só eu", kind: "personal", business: null, routerEnabled: false, role: "owner" },
    ],
    members: [
      { userId: U.ana, name: "Ana Ribeiro", email: "ana@estudio-aurora.example", avatarColor: "#3f6fa8", role: "owner", title: "Direção", statusText: null, online: true, runnerOnline: true, sectorId: "sec_tech" },
      { userId: U.bruno, name: "Bruno Lima", email: "bruno@estudio-aurora.example", avatarColor: "#a0574a", role: "admin", title: "Marketing", statusText: "Em reunião", online: true, runnerOnline: true, sectorId: "sec_mkt" },
      { userId: U.carla, name: "Carla Mendes", email: "carla@estudio-aurora.example", avatarColor: "#5a8a4a", role: "member", title: "Financeiro", statusText: null, online: false, runnerOnline: false, sectorId: "sec_fin" },
      { userId: U.diego, name: "Diego Souza", email: "diego@estudio-aurora.example", avatarColor: "#8a5aa0", role: "member", title: "Desenvolvimento", statusText: null, online: true, runnerOnline: false, sectorId: "sec_tech" },
    ],
    sectors: [
      { id: "sec_tech", name: "Tecnologia", leadUserId: U.ana },
      { id: "sec_mkt", name: "Marketing", leadUserId: U.bruno },
      { id: "sec_fin", name: "Finanças", leadUserId: U.carla },
    ],
    agents,
    channels,
    messages,
    runners: [
      { id: "run_ana", userId: U.ana, name: "macbook-ana", platform: "darwin", clis: [{ cli: "claude", version: "2.4.1", loggedIn: true }, { cli: "codex", version: "0.61.0", loggedIn: false }], isolation: "sandbox", online: true, lastSeenAt: now },
      { id: "run_bruno", userId: U.bruno, name: "desktop-bruno", platform: "linux", clis: [{ cli: "claude", version: "2.4.0", loggedIn: true }, { cli: "gemini", version: "1.9.2", loggedIn: true }], isolation: "container", online: true, lastSeenAt: now },
      { id: "run_diego", userId: U.diego, name: "wsl-diego", platform: "linux", clis: [{ cli: "codex", version: "0.61.0", loggedIn: true }], isolation: "sandbox", online: false, lastSeenAt: now - 2 * DAY },
    ],
    approvals: [
      { id: "apr_seed_1", agentId: A.tito, jobId: null, kind: "action", title: "Tito quer fazer merge do PR #131 na main", details: "Testes passando. Mudança em 4 arquivos do login.", approverUserId: U.ana, status: "pending", decidedBy: null, decidedAt: null, decisionNote: null, createdAt: now - 70 * MIN },
      { id: "apr_seed_2", agentId: A.lia, jobId: null, kind: "job_start", title: "Lia quer começar a rotina \"Posts da semana\"", details: "Rotina agendada para toda segunda às 9h.", approverUserId: U.ana, status: "pending", decidedBy: null, decidedAt: null, decisionNote: null, createdAt: now - 3 * HOUR },
    ],
    notifications: [
      { id: "ntf_1", kind: "approval", title: "Tito pediu sua aprovação", body: "Merge do PR #131 na main", link: "/aprovacoes", read: false, createdAt: now - 70 * MIN },
      { id: "ntf_2", kind: "mention", title: "Bruno mencionou você em #geral", body: "semana que vem começamos…", link: "/c/ch_geral", read: false, createdAt: now - 26 * HOUR },
      { id: "ntf_3", kind: "budget", title: "Lia usou 84% do orçamento do mês", body: null, link: null, read: true, createdAt: now - 2 * DAY },
    ],
    jobs: [
      { id: "job_seed_1", agentId: A.tito, channelId: "ch_dev", threadRootId: null, triggerMessageId: null, origin: "user", requestedByUserId: U.diego, parentJobId: null, routineId: null, prompt: "pode resumir os PRs abertos?", status: "done", runnerId: "run_bruno", runnerUserId: U.bruno, cli: "claude", model: "Opus 5.5", inputTokens: 9120, outputTokens: 512, error: null, errorCode: null, createdAt: now - 4 * HOUR - 2 * MIN, startedAt: now - 4 * HOUR - MIN, finishedAt: now - 4 * HOUR, waitingForRunner: false,
        events: [{ id: 1, jobId: "job_seed_1", kind: "status", summary: "Começou no computador desktop-bruno", createdAt: now - 4 * HOUR - MIN }, { id: 2, jobId: "job_seed_1", kind: "tool", summary: "Leu 2 PRs no GitHub", createdAt: now - 4 * HOUR - 30_000 }] },
      { id: "job_seed_5", agentId: A.tito, channelId: "ch_deploys", threadRootId: null, triggerMessageId: null, origin: "routine", requestedByUserId: null, parentJobId: null, routineId: "rt_1", prompt: "Resumo de PRs e issues", status: "failed", runnerId: "run_ana", runnerUserId: U.ana, cli: "claude", model: "Opus 5.5", inputTokens: 300, outputTokens: 0, error: "Limite do plano atingido.", errorCode: "limit", createdAt: now - DAY, startedAt: now - DAY, finishedAt: now - DAY + MIN, waitingForRunner: false,
        events: [{ id: 3, jobId: "job_seed_5", kind: "status", summary: "Parou: limite do plano atingido", createdAt: now - DAY + MIN }] },
    ],
    memories: [
      { id: "mem_1", scope: "agent", agentId: A.tito, content: "O time prefere PRs pequenos, com no máximo 300 linhas.", source: "extraction", createdBy: { type: "agent", id: A.tito }, createdAt: now - 5 * DAY, updatedAt: now - 5 * DAY },
      { id: "mem_2", scope: "agent", agentId: A.tito, content: "Deploy só depois das 14h, nunca na sexta.", source: "user", createdBy: { type: "user", id: U.ana }, createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY },
      { id: "mem_3", scope: "team", agentId: null, content: "Clientes principais: Padaria Sol, Loja Vento e Clínica Mar.", source: "user", createdBy: { type: "user", id: U.bruno }, createdAt: now - 10 * DAY, updatedAt: now - 10 * DAY },
    ],
    tokens: [{ id: "tok_1", name: "Script de relatórios", kind: "personal", createdAt: now - 9 * DAY, lastUsedAt: now - DAY }],
    files: [],
  };
}
