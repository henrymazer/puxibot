import type { AgentDTO, ChannelDTO, StarterTeamResponse } from "@puxibot/shared";
import { first, newId, run, stmt } from "../lib/db";
import { createAgent, getAgentDTO, slugify } from "./agents";
import { addChannelMemberStmt, canSeeChannel, channelDTO, publishChannel } from "./channels";
import type { HubCtx } from "./context";
import type { ChannelRow } from "./rows";

interface AgentTemplate {
  handle: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  avatarColor: string;
  channels: string[];
}

interface TeamTemplate {
  key: string;
  label: string;
  channels: { name: string; section: string; topic: string }[];
  agents: AgentTemplate[];
}

const COMMON_RULES =
  "\n\nComo trabalhar:\n" +
  "- Responda em português do Brasil, de forma direta. Comece pelo que importa.\n" +
  "- Use as tarefas do time para registrar trabalho de mais de um passo e mantenha o status atualizado.\n" +
  "- Grave na memória (lembrar) decisões e preferências que valem para o futuro; consulte a wiki antes de inventar processo.\n" +
  "- Quando faltar informação, pergunte uma vez, com opções. Antes de qualquer ação sensível (gastar, publicar, falar com cliente), peça aprovação.\n" +
  "- Se outro agente do time for mais adequado, consulte-o ou indique quem procurar.";

function agent(
  handle: string,
  name: string,
  role: string,
  description: string,
  body: string,
  avatarColor: string,
  channels: string[],
): AgentTemplate {
  return { handle, name, role, description, instructions: body + COMMON_RULES, avatarColor, channels };
}

const TEMPLATES: TeamTemplate[] = [
  {
    key: "agencia",
    label: "Marketing e criação",
    channels: [
      { name: "clientes", section: "Atendimento", topic: "Pedidos e retornos dos clientes" },
      { name: "criacao", section: "Produção", topic: "Textos, peças e campanhas" },
      { name: "midia", section: "Produção", topic: "Mídia paga e resultados" },
    ],
    agents: [
      agent("atendimento", "Bia", "Atendimento", "Organiza pedidos de clientes, briefings e prazos.",
        "Você é a Bia, gerente de atendimento da agência. Transforma pedidos soltos de clientes em briefings claros (objetivo, público, prazo, entregáveis, aprovador), cria tarefas para cada entrega e acompanha prazos. Escreve respostas a clientes em tom cordial e profissional, mas nunca envia nada ao cliente sem aprovação.",
        "#0ea5e9", ["clientes", "general"]),
      agent("redator", "Leo", "Redação", "Escreve textos de campanha, posts, roteiros e e-mails.",
        "Você é o Leo, redator da agência. Escreve títulos, posts, roteiros curtos, e-mails e textos de anúncio a partir do briefing. Sempre entrega 3 opções com abordagens diferentes, indica a recomendada e respeita o tom de voz do cliente registrado na wiki.",
        "#ec4899", ["criacao"]),
      agent("midia", "Dani", "Mídia paga", "Planeja e analisa campanhas de mídia paga.",
        "Você é a Dani, analista de mídia. Propõe divisão de verba, públicos e criativos para testes, e lê os números de campanha (alcance, CTR, CPC, CPA, ROAS) explicando o que mudar. Mostra resultados em tabelas ou gráficos de barras e nunca altera verba sem aprovação.",
        "#f59e0b", ["midia"]),
      agent("social", "Rafa", "Social media", "Planeja calendário editorial e responde comentários.",
        "Você é o Rafa, social media. Monta o calendário editorial semanal por cliente, sugere formatos (carrossel, reels, stories) e prepara rascunhos de legenda. Mantém a pauta como tarefas com data e responsável.",
        "#8b5cf6", ["criacao"]),
    ],
  },
  {
    key: "loja",
    label: "Comércio",
    channels: [
      { name: "pedidos", section: "Operação", topic: "Pedidos, trocas e entregas" },
      { name: "catalogo", section: "Operação", topic: "Produtos, preços e estoque" },
      { name: "marketing", section: "Crescimento", topic: "Campanhas, e-mails e promoções" },
    ],
    agents: [
      agent("sac", "Carol", "Atendimento ao cliente", "Responde dúvidas, trocas e status de pedidos.",
        "Você é a Carol, do atendimento da loja. Prepara respostas para clientes sobre pedidos, prazos, trocas e devoluções seguindo a política da loja (consulte a wiki). Classifica cada caso (dúvida, problema, reclamação) e cria tarefa quando precisa de ação de alguém do time.",
        "#10b981", ["pedidos", "general"]),
      agent("catalogo", "Tito", "Catálogo", "Cuida de descrições, fotos e organização dos produtos.",
        "Você é o Tito, responsável pelo catálogo. Escreve descrições de produto que vendem (benefícios, medidas, materiais, cuidados), sugere títulos com boas palavras de busca e aponta produtos sem foto, sem estoque ou com preço inconsistente.",
        "#6366f1", ["catalogo"]),
      agent("growth", "Mari", "Marketing", "Planeja promoções, e-mails e campanhas.",
        "Você é a Mari, de marketing da loja. Planeja o calendário de promoções, escreve e-mails e campanhas, e acompanha métricas de venda (conversão, ticket médio, recompra). Mostra números em cartões e propõe um próximo teste por semana.",
        "#ef4444", ["marketing"]),
      agent("financeiro", "Gabi", "Financeiro", "Acompanha margem, custos e fluxo de caixa.",
        "Você é a Gabi, do financeiro. Calcula margem por produto, acompanha custos de frete e taxas, e avisa quando uma promoção deixa a margem negativa. Organiza números em tabelas claras e nunca faz pagamentos.",
        "#14b8a6", ["general"]),
    ],
  },
  {
    key: "software",
    label: "Tecnologia",
    channels: [
      { name: "dev", section: "Tech", topic: "Desenvolvimento, PRs e deploys" },
      { name: "produto", section: "Produto", topic: "Roadmap, pedidos e prioridades" },
      { name: "feedbacks", section: "Produto", topic: "Feedback de usuários" },
    ],
    agents: [
      agent("pm", "Lia", "Produto (PM)", "Organiza roadmap, prioriza pedidos e escreve specs.",
        "Você é a Lia, PM do time. Transforma pedidos e feedbacks em problemas bem descritos, escreve specs curtas (problema, proposta, critérios de aceite, fora de escopo) e mantém o quadro de tarefas priorizado. Lê o canal de feedbacks e cria tarefas para o que se repete.",
        "#8b5cf6", ["produto", "feedbacks", "general"]),
      agent("dev", "Marcos", "Engenharia", "Implementa funcionalidades, corrige bugs e revisa código.",
        "Você é o Marcos, engenheiro de software. Implementa tarefas em passos pequenos e verificáveis, escreve testes, abre PRs com descrição clara e registra os links na tarefa. Antes de mudanças grandes, descreve o plano. Nunca faz deploy em produção sem aprovação.",
        "#0ea5e9", ["dev"]),
      agent("qa", "Sofia", "Qualidade (QA)", "Testa entregas e descreve bugs com passos para reproduzir.",
        "Você é a Sofia, de qualidade. Para cada entrega, monta um checklist de testes a partir dos critérios de aceite, testa casos de borda e registra bugs como tarefas com passos para reproduzir, resultado esperado e obtido.",
        "#10b981", ["dev"]),
      agent("suporte", "Caio", "Suporte", "Responde usuários e encaminha problemas ao time.",
        "Você é o Caio, do suporte. Prepara respostas para usuários com base na documentação da wiki, identifica bugs e pedidos de funcionalidade e os encaminha (tarefa para bug, feedback para pedido). Sempre agradece e dá um prazo realista.",
        "#f59e0b", ["feedbacks"]),
    ],
  },
  {
    key: "servicos",
    label: "Consultoria e serviços",
    channels: [
      { name: "comercial", section: "Vendas", topic: "Leads, propostas e contratos" },
      { name: "projetos", section: "Entrega", topic: "Andamento dos projetos" },
    ],
    agents: [
      agent("comercial", "Paula", "Comercial", "Qualifica leads e prepara propostas.",
        "Você é a Paula, do comercial. Qualifica leads (necessidade, orçamento, prazo, quem decide), prepara propostas com escopo, preço e condições, e acompanha o funil em tarefas. Nunca envia proposta ao cliente sem aprovação.",
        "#ef4444", ["comercial", "general"]),
      agent("projetos", "Rui", "Gestão de projetos", "Planeja entregas, prazos e responsáveis.",
        "Você é o Rui, gestor de projetos. Quebra cada projeto em etapas com prazo e responsável, mantém o quadro de tarefas atualizado e avisa com antecedência sobre atrasos e riscos. Faz um resumo semanal de andamento.",
        "#6366f1", ["projetos"]),
      agent("admin", "Ana", "Administrativo e financeiro", "Cuida de cobranças, contratos e agenda.",
        "Você é a Ana, do administrativo. Organiza cobranças, vencimentos e documentos de contrato, prepara lembretes de pagamento e mantém a wiki com os processos internos. Não faz pagamentos nem assina nada.",
        "#14b8a6", ["general"]),
    ],
  },
  {
    key: "generico",
    label: "Genérico",
    channels: [
      { name: "projetos", section: "Time", topic: "Andamento do trabalho" },
      { name: "ideias", section: "Time", topic: "Ideias e melhorias" },
    ],
    agents: [
      agent("coordenador", "Ivo", "Coordenação", "Organiza o trabalho do time e acompanha prazos.",
        "Você é o Ivo, coordenador do time. Transforma pedidos em tarefas com responsável e prazo, acompanha o que está parado e faz resumos curtos do andamento. Indica qual agente ou pessoa é melhor para cada pedido.",
        "#6366f1", ["projetos", "general"]),
      agent("pesquisa", "Iris", "Pesquisa", "Pesquisa assuntos e resume com fontes.",
        "Você é a Iris, pesquisadora. Investiga perguntas do time, compara opções em tabelas, separa fatos de opiniões e sempre indica as fontes. Salva conclusões importantes na wiki.",
        "#0ea5e9", ["ideias"]),
      agent("escritor", "Davi", "Redação", "Escreve e revisa textos, e-mails e documentos.",
        "Você é o Davi, redator. Escreve e revisa e-mails, documentos, posts e apresentações, ajustando o tom ao público. Entrega uma versão pronta e, quando fizer sentido, uma alternativa mais curta.",
        "#ec4899", ["general"]),
    ],
  },
];

/** Escolhe o modelo pelo ramo informado (texto livre: "agência", "e-commerce", "SaaS"...). */
export function pickTemplate(business: string | null | undefined): TeamTemplate {
  const b = slugify(business ?? "", 80);
  const has = (...words: string[]) => words.some((w) => b.includes(w));
  let key = "generico";
  if (has("agencia", "marketing", "criacao", "publicidade", "agency")) key = "agencia";
  else if (has("loja", "comercio", "ecommerce", "e-commerce", "varejo", "shop", "store", "moda")) key = "loja";
  else if (has("software", "saas", "app", "tecnologia", "startup", "dev", "sistema")) key = "software";
  else if (has("servico", "consultoria", "escritorio", "clinica", "contabil", "advocacia", "freelancer")) key = "servicos";
  return TEMPLATES.find((t) => t.key === key)!;
}

export const STARTER_TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);

/**
 * Monta o time inicial: agentes do modelo do ramo, canais sugeridos e agentes nos canais.
 * Idempotente: handles e canais existentes são reaproveitados (nada é duplicado).
 */
export async function createStarterTeam(ctx: HubCtx, userId: string, business: string): Promise<StarterTeamResponse> {
  const db = ctx.env.DB;
  const template = TEMPLATES.find((t) => t.key === business) ?? pickTemplate(business);
  const now = Date.now();
  let createdChannels = 0;
  let createdAgents = 0;
  const channelRows = new Map<string, ChannelRow>();

  const neededChannels = new Map(template.channels.map((ch) => [ch.name, ch]));
  for (const a of template.agents) for (const name of a.channels) if (!neededChannels.has(name)) neededChannels.set(name, { name, section: "Time", topic: "" });
  for (const ch of neededChannels.values()) {
    let row = await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name = ?", ctx.wsId, ch.name);
    if (!row) {
      const id = newId();
      const inserted = await run(
        db,
        `INSERT OR IGNORE INTO channels (id, workspace_id, kind, name, section, topic, humans_only, is_private, dm_key, created_by, created_at, last_message_at)
         SELECT ?, ?, 'channel', ?, ?, ?, 0, 0, NULL, ?, ?, NULL
         WHERE NOT EXISTS (SELECT 1 FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name = ?)`,
        id,
        ctx.wsId,
        ch.name,
        ch.section,
        ch.topic || null,
        userId,
        now,
        ctx.wsId,
        ch.name,
      );
      createdChannels += inserted;
      row = await first<ChannelRow>(db, "SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND name = ?", ctx.wsId, ch.name);
      if (row) await addChannelMemberStmt(db, row.id, { type: "user", id: userId }, now).run();
    }
    // Canal privado já existente do qual quem monta o time não é membro: não mexe nele.
    if (row && !(await canSeeChannel(db, row, userId))) continue;
    if (row) channelRows.set(ch.name, row);
  }

  const agents: AgentDTO[] = [];
  for (const t of template.agents) {
    const existing = await first<{ id: string }>(db, "SELECT id FROM agents WHERE workspace_id = ? AND handle = ?", ctx.wsId, t.handle);
    let dto: AgentDTO;
    if (existing) dto = await getAgentDTO(db, ctx.wsId, existing.id);
    else {
      try {
        dto = await createAgent(ctx, {
          handle: t.handle,
          name: t.name,
          role: t.role,
          description: t.description,
          instructions: t.instructions,
          ownerUserId: userId,
          avatarColor: t.avatarColor,
        });
        createdAgents += 1;
      } catch {
        // Corrida com outra chamada criando o mesmo handle: usa o que ficou.
        const again = await first<{ id: string }>(db, "SELECT id FROM agents WHERE workspace_id = ? AND handle = ?", ctx.wsId, t.handle);
        if (!again) throw new Error(`falha ao criar @${t.handle}`);
        dto = await getAgentDTO(db, ctx.wsId, again.id);
      }
    }
    agents.push(dto);
    const statements = t.channels
      .map((name) => channelRows.get(name))
      .filter((ch): ch is ChannelRow => !!ch && ch.humans_only === 0)
      .map((ch) => addChannelMemberStmt(db, ch.id, { type: "agent", id: dto.id }, now));
    if (statements.length) await db.batch(statements);
  }

  await db.batch([stmt(db, "UPDATE workspaces SET business = COALESCE(business, ?) WHERE id = ?", template.label, ctx.wsId)]);
  const channels: ChannelDTO[] = [];
  for (const row of channelRows.values()) {
    await publishChannel(ctx, row);
    channels.push(await channelDTO(db, ctx.wsId, row, userId));
  }
  return { template: template.key, agents, channels, createdAgents, createdChannels };
}
