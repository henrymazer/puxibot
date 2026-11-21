/**
 * Prévia do time inicial por ramo, espelhando os modelos do hub (apps/hub/src/domain/starterTeam.ts).
 * Serve só para mostrar o que será criado; quem cria de verdade é `POST /starter-team`.
 * O modo demonstração usa os mesmos dados.
 */
export interface StarterAgentPreview {
  handle: string;
  name: string;
  role: string;
  description: string;
  avatarColor: string;
  channels: string[];
}
export interface StarterTemplatePreview {
  key: "agencia" | "loja" | "software" | "servicos" | "generico";
  label: string;
  channels: { name: string; section: string; topic: string }[];
  agents: StarterAgentPreview[];
}

const a = (handle: string, name: string, role: string, description: string, avatarColor: string, channels: string[]): StarterAgentPreview => ({
  handle,
  name,
  role,
  description,
  avatarColor,
  channels,
});

export const STARTER_TEMPLATES: StarterTemplatePreview[] = [
  {
    key: "agencia",
    label: "Marketing e criação",
    channels: [
      { name: "clientes", section: "Atendimento", topic: "Pedidos e retornos dos clientes" },
      { name: "criacao", section: "Produção", topic: "Textos, peças e campanhas" },
      { name: "midia", section: "Produção", topic: "Mídia paga e resultados" },
    ],
    agents: [
      a("atendimento", "Bia", "Atendimento", "Organiza pedidos de clientes, briefings e prazos.", "#0ea5e9", ["clientes", "general"]),
      a("redator", "Leo", "Redação", "Escreve textos de campanha, posts, roteiros e e-mails.", "#ec4899", ["criacao"]),
      a("midia", "Dani", "Mídia paga", "Planeja e analisa campanhas de mídia paga.", "#f59e0b", ["midia"]),
      a("social", "Rafa", "Social media", "Planeja calendário editorial e responde comentários.", "#8b5cf6", ["criacao"]),
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
      a("sac", "Carol", "Atendimento ao cliente", "Responde dúvidas, trocas e status de pedidos.", "#10b981", ["pedidos", "general"]),
      a("catalogo", "Tito", "Catálogo", "Cuida de descrições, fotos e organização dos produtos.", "#6366f1", ["catalogo"]),
      a("growth", "Mari", "Marketing", "Planeja promoções, e-mails e campanhas.", "#ef4444", ["marketing"]),
      a("financeiro", "Gabi", "Financeiro", "Acompanha margem, custos e fluxo de caixa.", "#14b8a6", ["general"]),
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
      a("pm", "Lia", "Produto (PM)", "Organiza roadmap, prioriza pedidos e escreve specs.", "#8b5cf6", ["produto", "feedbacks", "general"]),
      a("dev", "Marcos", "Engenharia", "Implementa funcionalidades, corrige bugs e revisa código.", "#0ea5e9", ["dev"]),
      a("qa", "Sofia", "Qualidade (QA)", "Testa entregas e descreve bugs com passos para reproduzir.", "#10b981", ["dev"]),
      a("suporte", "Caio", "Suporte", "Responde usuários e encaminha problemas ao time.", "#f59e0b", ["feedbacks"]),
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
      a("comercial", "Paula", "Comercial", "Qualifica leads e prepara propostas.", "#ef4444", ["comercial", "general"]),
      a("projetos", "Rui", "Gestão de projetos", "Planeja entregas, prazos e responsáveis.", "#6366f1", ["projetos"]),
      a("admin", "Ana", "Administrativo e financeiro", "Cuida de cobranças, contratos e agenda.", "#14b8a6", ["general"]),
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
      a("coordenador", "Ivo", "Coordenação", "Organiza o trabalho do time e acompanha prazos.", "#6366f1", ["projetos", "general"]),
      a("pesquisa", "Iris", "Pesquisa", "Pesquisa assuntos e resume com fontes.", "#0ea5e9", ["ideias"]),
      a("escritor", "Davi", "Redação", "Escreve e revisa textos, e-mails e documentos.", "#ec4899", ["general"]),
    ],
  },
];

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Mesma escolha do hub: palavras-chave do ramo informado. */
export function pickStarterTemplate(business: string | null | undefined): StarterTemplatePreview {
  const b = slug(business ?? "");
  const has = (...words: string[]) => words.some((w) => b.includes(w));
  let key: StarterTemplatePreview["key"] = "generico";
  if (has("agencia", "marketing", "criacao", "publicidade", "agency")) key = "agencia";
  else if (has("loja", "comercio", "ecommerce", "e-commerce", "varejo", "shop", "store", "moda")) key = "loja";
  else if (has("software", "saas", "app", "tecnologia", "startup", "dev", "sistema")) key = "software";
  else if (has("servico", "consultoria", "escritorio", "clinica", "contabil", "advocacia", "freelancer")) key = "servicos";
  return STARTER_TEMPLATES.find((t) => t.key === key)!;
}
