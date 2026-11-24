/**
 * Ferramentas nativas do Puxibot expostas ao agente via MCP. Cada uma vira uma
 * chamada à API de ferramentas do hub (`/api/tool/*`, ver docs/contrato-api.md).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { setupPlanSchema } from "@puxibot/shared";
import type { RequestOptions } from "./hubApi.js";

export type Perm = { tool: "messages" | "memory" | "tasks" | "wiki" | "drive" | "agents"; level: "read" | "write" } | "always" | "assistant" | "builder";

export interface ToolContext {
  channelId: string | null;
  cwd: string;
  /** Faz a chamada e devolve o JSON (ou lança HubApiError). */
  call<T = unknown>(opts: RequestOptions): Promise<T>;
  raw(opts: RequestOptions): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>;
  sleep(ms: number): Promise<void>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Usado na mensagem de permissão negada: "você não tem permissão para <ação>". */
  action: string;
  perm: Perm;
  /**
   * O resultado traz texto escrito por outras pessoas ou vindo de fora (mensagens, wiki, arquivos):
   * vai para o modelo dentro de um bloco de dado externo, com esta origem.
   */
  untrusted?: string;
  input: z.ZodRawShape;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const cardSchema = z.union([
  z.object({
    type: z.literal("bars"),
    title: z.string(),
    subtitle: z.string().optional(),
    rows: z.array(z.object({ label: z.string(), value: z.number(), display: z.string().optional() })),
  }),
  z.object({ type: z.literal("table"), title: z.string().optional(), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({
    type: z.literal("checklist"),
    title: z.string(),
    items: z.array(z.object({ label: z.string(), done: z.boolean(), link: z.string().optional() })),
  }),
  z.object({ type: z.literal("stats"), title: z.string().optional(), items: z.array(z.object({ label: z.string(), value: z.string() })) }),
]);

const taskStatus = z.enum(["todo", "doing", "review", "done"]);
const priority = z.enum(["low", "medium", "high"]);

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

function filenameFrom(disposition: string | string[] | undefined, fallback: string): string {
  const d = Array.isArray(disposition) ? disposition[0] : disposition;
  const star = d && /filename\*=UTF-8''([^;]+)/i.exec(d);
  if (star?.[1]) return decodeURIComponent(star[1]);
  const plain = d && /filename="?([^";]+)"?/i.exec(d);
  return plain?.[1] ?? fallback;
}

export const TOOLS: ToolDef[] = [
  // ---------- Mensagens ----------
  {
    name: "enviar_mensagem",
    title: "Enviar mensagem",
    description:
      "Envia uma mensagem para OUTRO canal, para uma pessoa (DM) ou para outro agente. Não use para responder na conversa atual: sua resposta final já é publicada lá automaticamente. Informe exatamente um destino: `channel` (nome ou id), `toUser` (nome ou e-mail) ou `toAgent` (handle).",
    action: "enviar mensagens",
    perm: { tool: "messages", level: "write" },
    input: {
      body: z.string().min(1).max(20_000).describe("Texto da mensagem (Markdown)."),
      channel: z.string().optional().describe("Nome (sem #) ou id do canal."),
      toUser: z.string().optional().describe("Nome ou e-mail da pessoa, para DM."),
      toAgent: z.string().optional().describe("Handle do agente (sem @), para DM."),
      threadRootId: z.string().optional().describe("Id da mensagem raiz para responder numa thread."),
      cards: z.array(cardSchema).max(5).optional().describe("Cartões ricos: gráfico de barras, tabela, checklist ou números."),
    },
    run: (a, ctx) => ctx.call({ method: "POST", path: "/api/tool/messages", json: a }),
  },
  {
    name: "ler_mensagens",
    title: "Ler mensagens",
    description: "Lê as mensagens mais recentes de um canal (mais novas por último). Sem `channel`, lê a conversa atual.",
    action: "ler mensagens",
    perm: { tool: "messages", level: "read" },
    untrusted: "conversas do workspace",
    input: {
      channel: z.string().optional().describe("Nome ou id do canal. Padrão: a conversa deste pedido."),
      limit: z.number().int().min(1).max(100).optional().describe("Quantas mensagens (padrão 50)."),
      before: z.number().optional().describe("Só mensagens anteriores a este instante (ms), para paginar."),
    },
    run: (a, ctx) =>
      ctx.call({ method: "GET", path: "/api/tool/messages", query: { channel: (a.channel as string) ?? ctx.channelId, limit: a.limit as number, before: a.before as number } }),
  },
  {
    name: "listar_canais",
    title: "Listar canais",
    description: "Lista os canais do workspace que você pode ver, com nome, seção e tópico.",
    action: "ver os canais",
    perm: { tool: "messages", level: "read" },
    input: {},
    run: (_a, ctx) => ctx.call({ method: "GET", path: "/api/tool/channels" }),
  },
  {
    name: "buscar",
    title: "Buscar",
    description: "Busca texto em mensagens, tarefas, páginas da wiki e arquivos do workspace.",
    action: "buscar no workspace",
    perm: { tool: "messages", level: "read" },
    untrusted: "busca no workspace",
    input: { q: z.string().min(1).describe("Termos de busca.") },
    run: (a, ctx) => ctx.call({ method: "GET", path: "/api/tool/search", query: { q: a.q as string } }),
  },
  // ---------- Memória ----------
  {
    name: "lembrar",
    title: "Lembrar",
    description:
      "Guarda uma memória durável. `scope: agent` é a sua memória individual; `scope: team` é a memória do time, que todos os agentes leem. Guarde fatos úteis no futuro (preferências, decisões, contexto), uma ideia por memória, escrita de forma autoexplicativa.",
    action: "gravar memórias",
    perm: { tool: "memory", level: "write" },
    input: {
      scope: z.enum(["agent", "team"]).describe("agent = só sua; team = do time."),
      content: z.string().min(1).max(2000).describe("O que lembrar."),
      citacao: z
        .string()
        .max(600)
        .optional()
        .describe("Trecho copiado letra por letra da mensagem da pessoa que diz isso. Sem ele (ou se o trecho não existir na conversa), a memória fica marcada como não confirmada."),
    },
    run: (a, ctx) => ctx.call({ method: "POST", path: "/api/tool/memories", json: { scope: a.scope, content: a.content, ...(a.citacao ? { quote: a.citacao } : {}) } }),
  },
  {
    name: "consultar_memoria",
    title: "Consultar memória",
    description: "Procura nas memórias (suas e do time). Devolve id, escopo e conteúdo.",
    action: "ler memórias",
    perm: { tool: "memory", level: "read" },
    untrusted: "memórias",
    input: {
      q: z.string().optional().describe("Termos de busca; vazio lista as mais recentes."),
      scope: z.enum(["agent", "team"]).optional().describe("Filtra por escopo."),
    },
    run: (a, ctx) => ctx.call({ method: "GET", path: "/api/tool/memories", query: { q: a.q as string, scope: a.scope as string } }),
  },
  {
    name: "esquecer",
    title: "Esquecer",
    description: "Apaga uma memória pelo id (use quando ela estiver errada ou desatualizada).",
    action: "apagar memórias",
    perm: { tool: "memory", level: "write" },
    input: { id: z.string().min(1).describe("Id da memória (de consultar_memoria).") },
    run: (a, ctx) => ctx.call({ method: "DELETE", path: `/api/tool/memories/${encodeURIComponent(a.id as string)}` }),
  },
  // ---------- Tarefas ----------
  {
    name: "listar_tarefas",
    title: "Listar tarefas",
    description: "Lista tarefas do quadro do time, com filtros opcionais.",
    action: "ver tarefas",
    perm: { tool: "tasks", level: "read" },
    untrusted: "tarefas do time",
    input: {
      status: taskStatus.optional().describe("todo, doing, review ou done."),
      assignee: z.string().optional().describe("Handle do agente ou nome/e-mail da pessoa responsável."),
      q: z.string().optional().describe("Texto no título ou descrição."),
    },
    run: (a, ctx) => ctx.call({ method: "GET", path: "/api/tool/tasks", query: { status: a.status as string, assignee: a.assignee as string, q: a.q as string } }),
  },
  {
    name: "criar_tarefa",
    title: "Criar tarefa",
    description: "Cria uma tarefa no quadro. Responsável opcional: um agente (handle) ou uma pessoa (nome ou e-mail).",
    action: "criar tarefas",
    perm: { tool: "tasks", level: "write" },
    input: {
      title: z.string().min(1).max(300),
      description: z.string().max(20_000).optional(),
      status: taskStatus.optional(),
      priority: priority.optional(),
      labels: z.array(z.string().max(40)).max(10).optional(),
      project: z.string().max(60).optional(),
      assigneeAgent: z.string().optional().describe("Handle do agente responsável."),
      assigneeUser: z.string().optional().describe("Nome ou e-mail da pessoa responsável."),
    },
    run: (a, ctx) => ctx.call({ method: "POST", path: "/api/tool/tasks", json: a }),
  },
  {
    name: "atualizar_tarefa",
    title: "Atualizar tarefa",
    description: "Altera uma tarefa pelo número (ex.: mover para doing, mudar responsável, marcar subtarefas, vincular PR).",
    action: "alterar tarefas",
    perm: { tool: "tasks", level: "write" },
    input: {
      numero: z.number().int().positive().describe("Número da tarefa (#)."),
      title: z.string().max(300).optional(),
      description: z.string().max(20_000).optional(),
      status: taskStatus.optional(),
      priority: priority.optional(),
      labels: z.array(z.string().max(40)).max(10).optional(),
      project: z.string().max(60).optional(),
      assigneeAgent: z.string().optional(),
      assigneeUser: z.string().optional(),
      subtasks: z.array(z.object({ id: z.string().optional(), title: z.string(), done: z.boolean() })).optional(),
      links: z.array(z.object({ kind: z.enum(["pr", "issue", "url"]), label: z.string(), url: z.string() })).optional(),
    },
    run: (a, ctx) => {
      const { numero, ...rest } = a;
      return ctx.call({ method: "PATCH", path: `/api/tool/tasks/${Number(numero)}`, json: rest });
    },
  },
  {
    name: "comentar_tarefa",
    title: "Comentar tarefa",
    description: "Adiciona um comentário a uma tarefa pelo número.",
    action: "comentar tarefas",
    perm: { tool: "tasks", level: "write" },
    input: { numero: z.number().int().positive(), body: z.string().min(1).max(20_000) },
    run: (a, ctx) => ctx.call({ method: "POST", path: `/api/tool/tasks/${Number(a.numero)}/comments`, json: { body: a.body } }),
  },
  // ---------- Wiki ----------
  {
    name: "listar_wiki",
    title: "Listar wiki",
    description: "Lista as páginas e pastas da wiki do time (sem o conteúdo).",
    action: "ver a wiki",
    perm: { tool: "wiki", level: "read" },
    input: {},
    run: (_a, ctx) => ctx.call({ method: "GET", path: "/api/tool/wiki" }),
  },
  {
    name: "ler_pagina_wiki",
    title: "Ler página da wiki",
    description: "Lê uma página da wiki pelo id ou pelo título exato.",
    action: "ler a wiki",
    perm: { tool: "wiki", level: "read" },
    untrusted: "wiki do time",
    input: { pagina: z.string().min(1).describe("Id ou título da página.") },
    run: (a, ctx) => ctx.call({ method: "GET", path: `/api/tool/wiki/${encodeURIComponent(a.pagina as string)}` }),
  },
  {
    name: "escrever_pagina_wiki",
    title: "Escrever página da wiki",
    description:
      "Cria ou atualiza uma página da wiki. Com `id`, atualiza; sem `id`, cria (ou atualiza a página com o mesmo título). Use links [[Título]] para ligar páginas. `note` descreve a mudança no histórico.",
    action: "escrever na wiki",
    perm: { tool: "wiki", level: "write" },
    input: {
      id: z.string().optional(),
      title: z.string().min(1).max(200),
      body: z.string().max(200_000).describe("Conteúdo em Markdown."),
      parentTitle: z.string().optional().describe("Título da pasta/página pai."),
      note: z.string().max(300).optional(),
    },
    run: (a, ctx) => ctx.call({ method: "PUT", path: "/api/tool/wiki", json: a }),
  },
  // ---------- Drive ----------
  {
    name: "listar_arquivos",
    title: "Listar arquivos",
    description: "Lista arquivos do drive do time.",
    action: "ver o drive",
    perm: { tool: "drive", level: "read" },
    input: { q: z.string().optional().describe("Filtra pelo nome.") },
    run: (a, ctx) => ctx.call({ method: "GET", path: "/api/tool/files", query: { q: a.q as string } }),
  },
  {
    name: "baixar_arquivo",
    title: "Baixar arquivo",
    description: "Baixa um arquivo do drive para a sua pasta de trabalho (em downloads/). Arquivos de texto pequenos também voltam no resultado.",
    action: "baixar arquivos do drive",
    perm: { tool: "drive", level: "read" },
    untrusted: "arquivo do drive",
    input: { id: z.string().min(1).describe("Id do arquivo (de listar_arquivos).") },
    run: async (a, ctx) => {
      const res = await ctx.raw({ method: "GET", path: `/api/tool/files/${encodeURIComponent(a.id as string)}/content` });
      const name = path.basename(filenameFrom(res.headers["content-disposition"], String(a.id))).replace(/[\\/]/g, "_") || "arquivo";
      const dir = path.join(ctx.cwd, "downloads");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await fs.writeFile(file, res.body);
      const mime = String(res.headers["content-type"] ?? "application/octet-stream");
      const isText = /^text\/|json|xml|csv|markdown/.test(mime);
      return {
        path: file,
        size: res.body.length,
        mime,
        ...(isText && res.body.length <= 100_000 ? { content: res.body.toString("utf8") } : {}),
      };
    },
  },
  {
    name: "salvar_no_drive",
    title: "Salvar no drive",
    description: "Envia um arquivo da sua pasta de trabalho para o drive do time (máx. 25 MB). Use para tudo que for resultado do trabalho.",
    action: "salvar arquivos no drive",
    perm: { tool: "drive", level: "write" },
    input: {
      caminho: z.string().min(1).describe("Caminho do arquivo (relativo à pasta de trabalho ou absoluto)."),
      nome: z.string().optional().describe("Nome no drive (padrão: nome do arquivo)."),
      pasta: z.string().optional().describe("Pasta no drive."),
    },
    run: async (a, ctx) => {
      const file = path.resolve(ctx.cwd, a.caminho as string);
      const data = await fs.readFile(file);
      if (data.length > 25 * 1024 * 1024) throw new Error("arquivo maior que 25 MB");
      const name = (a.nome as string) || path.basename(file);
      const fields: Record<string, string> = { inDrive: "true" };
      if (a.pasta) fields.folder = a.pasta as string;
      if (ctx.channelId) fields.channelId = ctx.channelId;
      return ctx.call({
        method: "POST",
        path: "/api/tool/files",
        multipart: { fields, file: { field: "file", name, mime: MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream", data } },
      });
    },
  },
  // ---------- Time e agentes ----------
  {
    name: "listar_time",
    title: "Listar time",
    description: "Lista pessoas e agentes do workspace, com função/cargo e handle dos agentes.",
    action: "ver o time",
    perm: { tool: "agents", level: "read" },
    input: {},
    run: (_a, ctx) => ctx.call({ method: "GET", path: "/api/tool/team" }),
  },
  {
    name: "consultar_agente",
    title: "Consultar agente",
    description:
      "Pede algo a outro agente do time e espera a resposta (pode levar minutos). Escreva um pedido completo e autoexplicativo: o colega não vê esta conversa.",
    action: "consultar outros agentes",
    perm: { tool: "agents", level: "write" },
    input: {
      handle: z.string().min(1).describe("Handle do agente (sem @)."),
      prompt: z.string().min(1).max(20_000).describe("O pedido."),
    },
    run: (a, ctx) =>
      ctx.call({
        method: "POST",
        path: `/api/tool/agents/${encodeURIComponent(String(a.handle).replace(/^@/, ""))}/ask`,
        json: { prompt: a.prompt },
        timeoutMs: 60 * 60_000,
      }),
  },
  {
    name: "pedir_aprovacao",
    title: "Pedir aprovação",
    description:
      "Pede aprovação ao responsável pelo agente antes de uma ação sensível (gastar dinheiro, publicar, apagar, mandar algo para fora). Por padrão espera a decisão; não faça a ação se for rejeitada.",
    action: "pedir aprovações",
    perm: "always",
    input: {
      title: z.string().min(1).max(200).describe("O que você quer fazer, em uma linha."),
      details: z.string().max(5000).optional().describe("Detalhes e motivo."),
      aguardar: z.boolean().optional().describe("Esperar a decisão (padrão true)."),
      esperarMinutos: z.number().min(1).max(120).optional().describe("Quanto esperar no máximo (padrão 10)."),
    },
    run: async (a, ctx) => {
      const created = await ctx.call<{ id?: string; approval?: { id: string } }>({
        method: "POST",
        path: "/api/tool/approvals",
        json: { title: a.title, details: a.details },
      });
      const id = created.id ?? created.approval?.id;
      if (a.aguardar === false || !id) return created;
      const deadline = Date.now() + ((a.esperarMinutos as number) ?? 10) * 60_000;
      while (Date.now() < deadline) {
        await ctx.sleep(5000);
        const cur = await ctx.call<{ status?: string; approval?: { status?: string } }>({ method: "GET", path: `/api/tool/approvals/${encodeURIComponent(id)}` });
        const status = cur.status ?? cur.approval?.status;
        if (status && status !== "pending") return cur;
      }
      return { id, status: "pending", note: "Ainda sem decisão. Não faça a ação; avise na resposta que está aguardando aprovação." };
    },
  },
  {
    name: "pedir_segredo",
    title: "Pedir senha ou token",
    description:
      "Pede à pessoa uma senha ou um token por uma caixa segura do Puxibot. O valor vai direto para o cofre (login de site) ou para o conector; você nunca o vê e ele não passa pela conversa. Use sempre que precisar de um segredo: nunca peça para a pessoa escrever a senha numa mensagem. Depois de guardado, use `cofre_entrar` (login de site) ou tente o conector no próximo trabalho.",
    action: "pedir segredos",
    perm: "always",
    input: {
      nome: z.string().min(1).max(120).describe("Título da caixa, ex.: 'Senha do painel da transportadora'."),
      motivo: z.string().min(1).max(1000).describe("Para que serve e onde a pessoa acha o valor."),
      destino: z.enum(["cofre", "conector"]).describe("cofre: login de um site, usado pelo navegador. conector: token de um conector que já existe."),
      login: z.string().min(1).max(80).optional().describe("destino cofre: nome do login no cofre, ex.: 'Transportadora'."),
      site: z.string().min(3).max(300).optional().describe("destino cofre: endereço do site onde a senha será usada, ex.: painel.exemplo.com."),
      usuario: z.string().min(1).max(200).optional().describe("destino cofre: usuário ou e-mail do login, se você souber; senão a pessoa preenche."),
      conector: z.string().min(1).max(120).optional().describe("destino conector: nome do conector."),
      link: z.string().max(500).optional().describe("Página (https) onde a pessoa consegue o valor."),
      esperarMinutos: z.number().min(1).max(60).optional().describe("Quanto esperar no máximo (padrão 10)."),
    },
    run: async (a, ctx) => {
      let target: Record<string, unknown>;
      if (a.destino === "cofre") {
        if (!a.login || !a.site) throw new Error("Para o cofre, informe `login` e `site`.");
        target = { kind: "vault", name: a.login, site: a.site, ...(a.usuario ? { username: a.usuario } : {}) };
      } else {
        if (!a.conector) throw new Error("Para um conector, informe `conector`.");
        target = { kind: "connector", connector: a.conector };
      }
      const created = await ctx.call<{ id: string }>({
        method: "POST",
        path: "/api/tool/secret-requests",
        json: { label: a.nome, reason: a.motivo, ...(a.link ? { url: a.link } : {}), target },
      });
      const deadline = Date.now() + ((a.esperarMinutos as number) ?? 10) * 60_000;
      while (Date.now() < deadline) {
        await ctx.sleep(5000);
        const cur = await ctx.call<{ status?: string }>({ method: "GET", path: `/api/tool/approvals/${encodeURIComponent(created.id)}` });
        if (cur.status === "approved") return { status: "guardado", note: "O valor foi guardado. Você não o recebe: use o login do cofre ou o conector." };
        if (cur.status === "rejected") return { status: "recusado", note: "A pessoa preferiu não informar. Não peça de novo; siga sem isso e avise na resposta." };
      }
      return { status: "aguardando", note: "A pessoa ainda não respondeu. Avise na resposta que o pedido está na tela de Aprovações do Puxibot." };
    },
  },
  {
    name: "criar_agente",
    title: "Criar agente",
    description: "Cria um agente novo no workspace em nome da sua pessoa (só para o assistente pessoal).",
    action: "criar agentes",
    perm: "assistant",
    input: {
      handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/).describe("Handle único, minúsculas."),
      name: z.string().min(1).max(60),
      role: z.string().max(60).optional(),
      description: z.string().max(500).optional(),
      instructions: z.string().max(50_000).optional(),
    },
    run: (a, ctx) => ctx.call({ method: "POST", path: "/api/tool/agents", json: a }),
  },
  {
    name: "criar_rotina",
    title: "Criar rotina",
    description: "Cria uma rotina agendada (cron) para um agente em nome da sua pessoa (só para o assistente pessoal).",
    action: "criar rotinas",
    perm: "assistant",
    input: {
      agent: z.string().optional().describe("Handle do agente (padrão: você)."),
      name: z.string().min(1).max(100),
      prompt: z.string().min(1).max(20_000).describe("O que o agente deve fazer a cada execução."),
      cron: z.string().min(1).describe("Expressão cron, ex.: '0 9 * * 1-5'."),
      timezone: z.string().optional().describe("Fuso, ex.: America/Sao_Paulo."),
      channel: z.string().optional().describe("Canal (nome ou id) onde publicar o resultado."),
    },
    run: (a, ctx) => ctx.call({ method: "POST", path: "/api/tool/routines", json: a }),
  },
  // ---------- Só o agente criador ----------
  {
    name: "listar_catalogo_conectores",
    title: "Listar catálogo de conectores",
    description: "Lista os apps com conexão pronta (id, nome, para que serve, requisitos) e os conectores que o time já tem. Use antes de propor a estrutura.",
    action: "ver o catálogo de conectores",
    perm: "builder",
    input: {},
    run: (_a, ctx) => ctx.call({ method: "GET", path: "/api/tool/setup/catalog" }),
  },
  {
    name: "propor_estrutura",
    title: "Propor estrutura",
    description:
      "Entrega o plano completo da estrutura do time para a pessoa revisar na tela: canais, agentes, skills, rotinas, páginas da wiki, memórias e conectores necessários. Não cria nada: quem cria é a pessoa, pelo botão da tela. Chamar de novo substitui o plano anterior, então mande sempre o plano inteiro.",
    action: "propor a estrutura do time",
    perm: "builder",
    input: setupPlanSchema.shape,
    run: (a, ctx) => ctx.call({ method: "POST", path: "/api/tool/setup/plan", json: a }),
  },
  {
    name: "reportar_progresso",
    title: "Reportar progresso",
    description: "Registra um resumo curto do andamento (aparece na atividade do agente). Use em trabalhos longos.",
    action: "reportar progresso",
    perm: "always",
    input: { summary: z.string().min(1).max(500) },
    run: (a, ctx) => ctx.call({ method: "POST", path: "/api/tool/progress", json: { summary: a.summary } }),
  },
];

/** A ferramenta deve ser oferecida, dadas as permissões conhecidas do agente? */
export function toolAllowed(t: ToolDef, perms: Record<string, string> | null, isAssistant: boolean | null, agentKind: string | null = null): boolean {
  if (t.perm === "always") return true;
  if (t.perm === "assistant") return isAssistant !== false;
  if (t.perm === "builder") return agentKind === "builder";
  if (!perms) return true;
  // Ausente = padrão do contrato para ferramentas nativas (`write`); o hub confere de novo.
  const level = perms[t.perm.tool] ?? "write";
  if (t.perm.level === "read") return level === "read" || level === "write";
  return level === "write";
}
