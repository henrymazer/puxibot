/**
 * Pasta de trabalho do agente e montagem do prompt.
 *
 * O prompt tem duas partes:
 *  - sistema (fixo por agente): quem é, instruções, como trabalhar e usar as ferramentas;
 *  - pedido (dinâmico): quem pediu, onde, contexto da conversa, memórias, colegas.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JobAssignment } from "@puxibot/shared";
import { paths } from "./config.js";
import { safeMkdir, safeRemove, safeWriteFile } from "./safefs.js";

export async function ensureAgentDir(a: JobAssignment): Promise<string> {
  const dir = paths.agentDir(a.workspace.id, a.agent.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function skillSlug(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "skill";
}

/** Grava as skills do agente no formato SKILL.md (frontmatter name/description). */
export async function writeSkills(workdir: string, skillsDir: string, skills: JobAssignment["agent"]["skills"]): Promise<string[]> {
  const root = path.join(workdir, skillsDir);
  // A pasta é gerenciada pelo Puxibot: recriada a cada job a partir do hub. A pasta de
  // trabalho tem escrita no isolamento, então nada aqui segue links deixados pelo agente
  // (ex.: `.claude -> ~/.claude`).
  await safeRemove(workdir, root);
  if (!skills.length) return [];
  await safeMkdir(workdir, root);
  const used = new Set<string>();
  const written: string[] = [];
  for (const s of skills) {
    let slug = skillSlug(s.name);
    for (let i = 2; used.has(slug); i++) slug = `${skillSlug(s.name).slice(0, 60)}-${i}`;
    used.add(slug);
    const dir = path.join(root, slug);
    const description = (s.description || s.name).replace(/\s+/g, " ").trim();
    const body = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${s.name}\n\n${s.body.trim()}\n`;
    await safeWriteFile(workdir, path.join(dir, "SKILL.md"), body, 0o644);
    written.push(slug);
  }
  return written;
}

const TOOL_GUIDE: { name: string; perm: string; text: string }[] = [
  { name: "enviar_mensagem", perm: "messages", text: "fala em OUTRO canal, DM com pessoa ou com outro agente" },
  { name: "ler_mensagens / listar_canais / buscar", perm: "messages", text: "consulta conversas e busca no workspace" },
  { name: "lembrar / consultar_memoria / esquecer", perm: "memory", text: "memória durável: sua (scope agent) ou do time (scope team)" },
  { name: "listar_tarefas / criar_tarefa / atualizar_tarefa / comentar_tarefa", perm: "tasks", text: "quadro de tarefas do time" },
  { name: "listar_wiki / ler_pagina_wiki / escrever_pagina_wiki", perm: "wiki", text: "wiki do time" },
  { name: "listar_arquivos / baixar_arquivo / salvar_no_drive", perm: "drive", text: "drive do time; resultados que valem guardar vão para o drive" },
  { name: "listar_time / consultar_agente", perm: "agents", text: "pessoas e agentes do time; peça ajuda a um colega agente" },
  { name: "pedir_aprovacao", perm: "", text: "peça aprovação humana antes de qualquer ação sensível ou irreversível" },
  { name: "reportar_progresso", perm: "", text: "conte o andamento em trabalhos longos" },
];

export function buildSystemPrompt(a: JobAssignment, workdir: string, skillNames: string[], skillsDir?: string): string {
  const ag = a.agent;
  const parts: string[] = [];
  parts.push(
    `Você é ${ag.name} (@${ag.handle})${ag.role ? `, ${ag.role}` : ""}, um agente de IA do Puxibot no workspace "${a.workspace.name}". ` +
      `O Puxibot é o chat onde pessoas e agentes do time trabalham juntos.`,
  );
  if (ag.isAssistant) {
    parts.push(
      "Você é o assistente pessoal da pessoa dona deste agente e age com as permissões dela (pode criar agentes e rotinas e mandar mensagens em nome dela, sempre identificado como assistente).",
    );
  }
  if (ag.instructions.trim()) parts.push(`## Suas instruções\n\n${ag.instructions.trim()}`);

  parts.push(
    [
      "## Como você trabalha",
      "- O TEXTO FINAL da sua resposta é publicado automaticamente como a sua mensagem na conversa de onde veio o pedido. Escreva-o já como a mensagem para o time: direto, em português do Brasil, sem comentar as ferramentas que usou.",
      "- Não use `enviar_mensagem` para responder na própria conversa do pedido: isso duplicaria a resposta. Use-a só para falar em outro canal, numa DM ou com outro agente.",
      "- Se o pedido não exigir nenhuma resposta (por exemplo, uma rotina sem novidades), termine com uma resposta vazia.",
      `- Sua pasta de trabalho é \`${workdir}\`. Grave arquivos só nela ou em /tmp; o resto do sistema é somente leitura. Ela é descartável: o que for resultado deve ir para o drive com \`salvar_no_drive\`.`,
      "- Mensagens podem ter cartões (gráficos, tabelas, checklists) passando `cards` em `enviar_mensagem`.",
    ].join("\n"),
  );

  const lines = ["## Ferramentas do Puxibot (servidor MCP `puxibot`)"];
  for (const t of TOOL_GUIDE) {
    const level = t.perm ? (ag.toolPerms[t.perm] ?? "write") : "write";
    if (level === "none") continue;
    lines.push(`- ${t.name}: ${t.text}${level === "read" ? " (você só tem leitura)" : ""}`);
  }
  if (ag.isAssistant) lines.push("- criar_agente / criar_rotina: cria agentes e rotinas agendadas em nome da sua pessoa");
  lines.push(
    "- Use `lembrar` para guardar fatos duráveis que vão ser úteis depois (preferências, decisões, contexto do time). Não guarde coisas passageiras.",
    "- Se uma ferramenta responder que você não tem permissão, não tente contornar: explique na resposta o que faltou e quem pode liberar (o responsável pelo agente ou um admin).",
  );
  parts.push(lines.join("\n"));

  const conns = a.connectors.filter((c) => c.level !== "none");
  if (conns.length) {
    parts.push(
      [
        "## Conectores externos",
        ...conns.map((c) =>
          c.level === "read"
            ? `- ${c.name}: SOMENTE LEITURA. Use apenas ferramentas que consultam; não crie, altere nem apague nada por ele.`
            : `- ${c.name}: leitura e escrita.`,
        ),
      ].join("\n"),
    );
  }
  if (skillNames.length) {
    parts.push(
      [
        "## Skills",
        // Descoberta progressiva: aqui vai só o resumo; o texto completo fica no arquivo e só entra
        // no contexto quando o agente o lê.
        skillsDir
          ? "Você tem estas skills (instruções detalhadas para tarefas específicas). Quando uma se aplicar ao pedido, leia o arquivo dela antes de agir:"
          : "Você tem estas skills (instruções detalhadas para tarefas específicas). Use a que se aplicar ao pedido:",
        ...a.agent.skills.map((s, i) => {
          const name = skillNames[i] ?? s.name;
          const file = skillsDir && skillNames[i] ? ` (arquivo: ${skillsDir}/${skillNames[i]}/SKILL.md)` : "";
          return `- ${name}: ${s.description || s.name}${file}`;
        }),
      ].join("\n"),
    );
  }
  return parts.join("\n\n") + "\n";
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export interface UserPromptOptions {
  /** Ao retomar uma sessão, só entram mensagens de contexto mais novas que isto. */
  contextSince?: number | null;
}

export function buildUserPrompt(a: JobAssignment, opts: UserPromptOptions = {}): string {
  const out: string[] = [];
  const where = a.channel
    ? a.channel.kind === "dm"
      ? "uma DM com você"
      : `o canal #${a.channel.name ?? a.channel.id}`
    : "fora de uma conversa (sem canal)";
  const origin: Record<JobAssignment["origin"], string> = {
    user: "pedido de uma pessoa",
    routine: "rotina agendada",
    agent: "pedido de outro agente",
    system: "pedido do sistema",
  };
  out.push(
    "# Pedido",
    `- Origem: ${origin[a.origin]}`,
    `- Quem pediu: ${a.requestedBy ? a.requestedBy.name : "ninguém diretamente (trabalho que ninguém pediu)"}`,
    `- Onde: ${where}${a.threadRootId ? " (dentro de uma thread)" : ""}`,
    `- Agora: ${fmtTime(Date.now())}`,
  );

  const ctx = opts.contextSince ? a.context.filter((m) => m.createdAt > opts.contextSince!) : a.context;
  if (ctx.length) {
    out.push(
      "",
      opts.contextSince ? "## Mensagens novas na conversa desde a sua última resposta" : "## Contexto recente da conversa (mais antigas primeiro)",
    );
    for (const m of ctx) {
      const kind = m.authorType === "agent" ? "agente" : m.authorType === "system" ? "sistema" : "pessoa";
      out.push(`[${fmtTime(m.createdAt)}] ${m.author} (${kind}): ${m.body}`);
    }
  }

  const mine = a.memories.filter((m) => m.scope === "agent");
  const team = a.memories.filter((m) => m.scope === "team");
  if (mine.length || team.length) {
    out.push("", "## Memórias");
    if (mine.length) out.push("### Suas", ...mine.map((m) => `- ${m.content}`));
    if (team.length) out.push("### Do time", ...team.map((m) => `- ${m.content}`));
  }

  if (a.teammates.length) {
    out.push(
      "",
      "## Colegas agentes disponíveis (use `consultar_agente` com o handle)",
      ...a.teammates.map((t) => `- @${t.handle} — ${t.name}${t.role ? ` (${t.role})` : ""}`),
    );
  }

  out.push("", "## Mensagem a responder", a.prompt.trim());
  return out.join("\n") + "\n";
}
