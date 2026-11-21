/** Wiki no modo demonstração: árvore, revisões, conflito de versão, lixeira, estatísticas e grafo. */
import type { ActorRef, MessageDTO, WikiPageDTO, WikiRevisionDTO, WikiStatsDTO } from "@puxibot/shared";
import { extractWikiLinks, normalizeTitle, titleIndex } from "../../lib/wikiLinks";
import { HttpError, type DemoContext, type DemoDb } from "../backend";
import type { AreaDb } from "../seedAreas";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const user = (id: string): ActorRef => ({ type: "user", id });
const agent = (id: string): ActorRef => ({ type: "agent", id });

export function seedWiki(base: DemoDb): Pick<AreaDb, "wikiPages" | "wikiRevisions" | "wikiReads"> {
  const now = Date.now();
  const ana = base.user.id;
  const [, bruno, carla, diego] = base.members.map((m) => m.userId) as [string, string, string, string];
  const pages: WikiPageDTO[] = [];
  const revisions: WikiRevisionDTO[] = [];
  let rev = 0;

  /** Cria a página com o histórico dado (mais antiga primeiro). */
  const page = (
    id: string,
    parentId: string | null,
    title: string,
    history: { body: string; author: ActorRef; onBehalfOfUserId?: string | null; note?: string | null; at: number; title?: string }[],
    extra: Partial<WikiPageDTO> = {},
  ) => {
    history.forEach((h, i) =>
      revisions.push({
        id: `wrv_seed_${++rev}`,
        pageId: id,
        version: i + 1,
        title: h.title ?? title,
        body: h.body,
        author: h.author,
        onBehalfOfUserId: h.onBehalfOfUserId ?? null,
        note: h.note ?? null,
        createdAt: h.at,
      }),
    );
    const last = history[history.length - 1]!;
    pages.push({
      id,
      parentId,
      isFolder: false,
      title,
      body: last.body,
      version: history.length,
      deleted: false,
      updatedBy: last.author,
      onBehalfOfUserId: last.onBehalfOfUserId ?? null,
      createdAt: history[0]!.at,
      updatedAt: last.at,
      ...extra,
    });
  };
  const folder = (id: string, title: string, at: number) =>
    pages.push({ id, parentId: null, isFolder: true, title, body: "", version: 1, deleted: false, updatedBy: user(ana), onBehalfOfUserId: null, createdAt: at, updatedAt: at });

  folder("wk_f_proc", "Processos", now - 40 * DAY);
  folder("wk_f_marca", "Marca e clientes", now - 38 * DAY);
  folder("wk_f_time", "Time", now - 35 * DAY);

  const deployV1 =
    "Como publicamos uma versão nova do app.\n\n## Antes\n\n1. Testes passando na main.\n2. Alguém revisou o PR (veja [[Revisão de código]]).\n\n## Publicar\n\n```bash\nnpm run deploy\n```\n\nSó depois das 14h e nunca na sexta.";
  const deployV2 =
    deployV1 +
    "\n\n## Se der errado\n\n- Volte a versão anterior com `npm run rollback`.\n- Avise em #deploys.\n- Termos desconhecidos? Veja o [[Glossário]].";
  const deployV3 = deployV2 + "\n\n> Pessoas novas: leiam também [[Onboarding de novas pessoas]].";
  page("wk_deploy", "wk_f_proc", "Processo de deploy", [
    { body: deployV1, author: user(ana), at: now - 30 * DAY, note: "Primeira versão" },
    { body: deployV2, author: agent("agt_theo"), onBehalfOfUserId: ana, at: now - 6 * DAY, note: "Passos do rollback" },
    { body: deployV3, author: user(diego), at: now - 2 * HOUR },
  ]);
  page("wk_review", "wk_f_proc", "Revisão de código", [
    {
      body: "PRs pequenos, com no máximo 300 linhas.\n\n- Quem abre o PR descreve o que mudou e como testar.\n- Quem revisa roda os testes antes de aprovar.\n- Depois de aprovado, siga o [[Processo de deploy]].",
      author: agent("agt_theo"),
      onBehalfOfUserId: diego,
      at: now - 20 * DAY,
    },
  ]);
  page("wk_tom", "wk_f_marca", "Tom de voz", [
    { body: "Frases curtas e sem jargão.", author: user(bruno), at: now - 25 * DAY },
    {
      body: "Como o estúdio fala com os [[Clientes]].\n\n- Frases curtas e sem jargão.\n- Sempre um próximo passo claro.\n- Nada de \"prezado\": tratamos por *você*.",
      author: agent("agt_lia"),
      onBehalfOfUserId: bruno,
      at: now - 4 * DAY,
      note: "Exemplos de saudação",
    },
  ]);
  page("wk_clientes", "wk_f_marca", "Clientes", [
    {
      body: "| Cliente | Contato | Desde |\n|---|---|---|\n| Padaria Sol | Marta | 2024 |\n| Loja Vento | Caio | 2025 |\n| Clínica Mar | Dra. Lu | 2026 |\n\nComo falar com eles: [[Tom de voz]]. Modelos de contrato: [[Contratos]].",
      author: user(bruno),
      at: now - 15 * DAY,
    },
  ]);
  page("wk_onboarding", "wk_f_time", "Onboarding de novas pessoas", [
    {
      body: "Bem-vinda, bem-vindo!\n\n1. Leia o [[Glossário]].\n2. Entenda o [[Tom de voz]].\n3. Acompanhe um [[Processo de deploy]] com alguém do time.\n4. Converse com o @tito e a @lia no chat.",
      author: user(ana),
      at: now - 12 * DAY,
    },
  ]);
  page("wk_rituais", "wk_f_time", "Rituais do time", [
    { body: "- Segunda 9h: prioridades da semana.\n- Sexta 16h: retrospectiva.\n- Resumo diário dos assistentes às 9h.", author: user(carla), at: now - 9 * DAY },
  ]);
  page("wk_glossario", null, "Glossário", [
    {
      body: "**Runner**: programa que roda os agentes no seu computador.\n\n**Hub**: o servidor do time.\n\n**Rollback**: voltar para a versão anterior (veja [[Processo de deploy]]).",
      author: user(ana),
      at: now - 18 * DAY,
    },
  ]);
  page("wk_old", "wk_f_proc", "Rascunho antigo de deploy", [{ body: "Usar o FTP do servidor antigo.", author: user(diego), at: now - 60 * DAY }], {
    deleted: true,
    updatedAt: now - 3 * DAY,
    updatedBy: user(diego),
  });

  const reads: AreaDb["wikiReads"] = [];
  const read = (pageId: string, reader: ActorRef, times: number, lastAgo: number) => {
    for (let i = 0; i < times; i++) reads.push({ pageId, reader, at: now - lastAgo - i * 7 * HOUR });
  };
  read("wk_deploy", agent("agt_theo"), 12, 30 * MIN);
  read("wk_deploy", user(diego), 4, 2 * HOUR);
  read("wk_deploy", user(ana), 2, DAY);
  read("wk_deploy", agent("agt_lia"), 1, 3 * DAY);
  read("wk_tom", agent("agt_lia"), 9, HOUR);
  read("wk_glossario", user(carla), 3, 5 * HOUR);
  read("wk_onboarding", user(diego), 2, 2 * DAY);
  read("wk_review", agent("agt_theo"), 5, 4 * HOUR);
  read("wk_deploy", user(bruno), 3, 10 * DAY); // fora da semana
  return { wikiPages: pages, wikiRevisions: revisions, wikiReads: reads };
}

export function registerWiki(ctx: DemoContext): void {
  const { db, on, emit, W } = ctx;
  const isAdmin = () => ctx.me().role !== "member";
  const list = (p: WikiPageDTO): WikiPageDTO => ({ ...p, body: "" });
  const find = (id: string) => {
    const p = db.wikiPages.find((x) => x.id === id);
    if (!p) throw new HttpError(404, "not_found", "Página não encontrada.");
    return p;
  };
  const changed = (id: string) => emit({ type: "wiki.changed", pageId: id });
  const descendants = (id: string): WikiPageDTO[] => {
    const out: WikiPageDTO[] = [];
    const walk = (pid: string) => {
      for (const c of db.wikiPages.filter((x) => x.parentId === pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  };
  const addRevision = (p: WikiPageDTO, author: ActorRef, onBehalfOfUserId: string | null, note: string | null) => {
    db.wikiRevisions.push({
      id: ctx.id("wrv"),
      pageId: p.id,
      version: p.version,
      title: p.title,
      body: p.body,
      author,
      onBehalfOfUserId,
      note,
      createdAt: p.updatedAt,
    });
  };
  /** Edição feita "por outra pessoa" (agente em nome de alguém), para testar o conflito de versão. */
  const agentEdit = (id: string) => {
    const p = db.wikiPages.find((x) => x.id === id && !x.deleted && !x.isFolder);
    if (!p) return;
    p.body += `\n\n**Novo termo**: adicionado pelo Tito às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`;
    p.version++;
    p.updatedAt = Date.now();
    p.updatedBy = { type: "agent", id: "agt_theo" };
    p.onBehalfOfUserId = db.members[1]?.userId ?? null;
    addRevision(p, p.updatedBy, p.onBehalfOfUserId, "Termo novo");
    changed(p.id);
  };
  (window as unknown as { __demoWikiConflict?: (id?: string) => void }).__demoWikiConflict = (id = "wk_glossario") => agentEdit(id);
  let glossaryTimerUsed = false;

  // Uma mensagem que cita a página, para as estatísticas mostrarem "onde foi mencionada".
  const msg: MessageDTO = {
    id: "msg_wiki_mention",
    channelId: "ch_dev",
    author: { type: "user", id: db.members[3]?.userId ?? db.user.id },
    body: "Atualizei o [[Processo de deploy]] com o passo de rollback. Deem uma olhada!",
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
    createdAt: Date.now() - 2 * HOUR + MIN,
  };
  db.messages.push(msg);

  on("GET", `${W}/wiki`, ({ query }) => {
    const trash = query.get("trash") === "1";
    return { items: db.wikiPages.filter((p) => p.deleted === trash).map(list) };
  });

  on(
    "POST",
    `${W}/wiki`,
    ({ body }) => {
      const title = String(body.title ?? "").trim();
      if (!title) throw new HttpError(400, "invalid", "Dê um título à página.");
      const parentId = body.parentId || null;
      if (parentId) {
        const parent = find(parentId);
        if (!parent.isFolder || parent.deleted) throw new HttpError(400, "invalid_parent", "Escolha uma pasta que exista.");
      }
      const now = Date.now();
      const p: WikiPageDTO = {
        id: ctx.id("wk"),
        parentId,
        isFolder: !!body.isFolder,
        title,
        body: body.isFolder ? "" : String(body.body ?? ""),
        version: 1,
        deleted: false,
        updatedBy: { type: "user", id: db.user.id },
        onBehalfOfUserId: null,
        createdAt: now,
        updatedAt: now,
      };
      db.wikiPages.push(p);
      if (!p.isFolder) addRevision(p, p.updatedBy, null, "Página criada");
      changed(p.id);
      return p;
    },
    201,
  );

  on("GET", `${W}/wiki/:id`, ({ m }) => {
    const p = find(m[2]!);
    db.wikiReads.push({ pageId: p.id, reader: { type: "user", id: db.user.id }, at: Date.now() });
    // O Glossário recebe uma edição de agente alguns segundos depois de aberto (só uma vez), para mostrar o conflito.
    if (p.id === "wk_glossario" && !glossaryTimerUsed) {
      glossaryTimerUsed = true;
      setTimeout(() => agentEdit(p.id), 8000);
    }
    return p;
  });

  on("PATCH", `${W}/wiki/:id`, async ({ m, body }) => {
    await ctx.sleep(150);
    const p = find(m[2]!);
    if (p.deleted) throw new HttpError(400, "deleted", "A página está na lixeira. Restaure antes de editar.");
    if (body.baseVersion !== undefined && body.baseVersion !== p.version) {
      throw new HttpError(409, "version_conflict", "Outra pessoa ou agente salvou esta página depois que você abriu. Recarregue ou sobrescreva.");
    }
    if (body.title !== undefined && !String(body.title).trim()) throw new HttpError(400, "invalid", "O título não pode ficar vazio.");
    if (body.parentId !== undefined) {
      const target = body.parentId || null;
      if (target) {
        const parent = find(target);
        if (!parent.isFolder) throw new HttpError(400, "invalid_parent", "Só dá para mover para uma pasta.");
        if (target === p.id || descendants(p.id).some((d) => d.id === target)) throw new HttpError(400, "invalid_parent", "Uma pasta não pode ficar dentro dela mesma.");
      }
      p.parentId = target;
    }
    if (body.title !== undefined) p.title = String(body.title).trim();
    if (body.body !== undefined && !p.isFolder) p.body = String(body.body);
    p.version++;
    p.updatedAt = Date.now();
    p.updatedBy = { type: "user", id: db.user.id };
    p.onBehalfOfUserId = null;
    if (!p.isFolder) addRevision(p, p.updatedBy, null, body.note ? String(body.note) : null);
    changed(p.id);
    return p;
  });

  on("DELETE", `${W}/wiki/:id`, ({ m, query }) => {
    const p = find(m[2]!);
    const all = [p, ...descendants(p.id)];
    if (query.get("permanent") === "1") {
      if (!isAdmin()) throw new HttpError(403, "forbidden", "Só admins apagam de vez.");
      const ids = new Set(all.map((x) => x.id));
      db.wikiPages = db.wikiPages.filter((x) => !ids.has(x.id));
      db.wikiRevisions = db.wikiRevisions.filter((r) => !ids.has(r.pageId));
    } else {
      const now = Date.now();
      for (const x of all) {
        if (x.deleted) continue;
        x.deleted = true;
        x.updatedAt = now;
        x.updatedBy = { type: "user", id: db.user.id };
        x.onBehalfOfUserId = null;
      }
    }
    changed(p.id);
  });

  on("POST", `${W}/wiki/:id/restore`, ({ m }) => {
    const p = find(m[2]!);
    const now = Date.now();
    for (const x of [p, ...descendants(p.id)]) {
      x.deleted = false;
      x.updatedAt = now;
    }
    const parent = p.parentId ? db.wikiPages.find((x) => x.id === p.parentId) : undefined;
    if (p.parentId && (!parent || parent.deleted)) p.parentId = null;
    changed(p.id);
    return p;
  });

  on("GET", `${W}/wiki/:id/revisions`, ({ m }) => {
    find(m[2]!);
    return { items: db.wikiRevisions.filter((r) => r.pageId === m[2]).sort((a, b) => b.version - a.version) };
  });

  on("GET", `${W}/wiki/:id/stats`, ({ m }): WikiStatsDTO => {
    const p = find(m[2]!);
    const weekAgo = Date.now() - 7 * DAY;
    const recent = db.wikiReads.filter((r) => r.pageId === p.id && r.at >= weekAgo);
    const byReader = new Map<string, { reader: ActorRef; count: number; lastAt: number }>();
    for (const r of recent) {
      const k = `${r.reader.type}:${r.reader.id}`;
      const cur = byReader.get(k) ?? { reader: r.reader, count: 0, lastAt: 0 };
      cur.count++;
      cur.lastAt = Math.max(cur.lastAt, r.at);
      byReader.set(k, cur);
    }
    const key = normalizeTitle(p.title);
    const mentionedIn: WikiStatsDTO["mentionedIn"] = [];
    for (const other of db.wikiPages) {
      if (other.id === p.id || other.deleted || other.isFolder) continue;
      if (extractWikiLinks(other.body).some((t) => normalizeTitle(t) === key)) {
        const line = other.body.split("\n").find((l) => normalizeTitle(l).includes(`[[${key}`)) ?? "";
        mentionedIn.push({ kind: "page", id: other.id, title: other.title, excerpt: line.trim().slice(0, 140) });
      }
    }
    for (const msg of db.messages) {
      if (msg.deleted) continue;
      if (extractWikiLinks(msg.body).some((t) => normalizeTitle(t) === key)) {
        const ch = db.channels.find((c) => c.id === msg.channelId);
        mentionedIn.push({ kind: "message", id: msg.id, title: ch?.name ? `#${ch.name}` : "Conversa", excerpt: msg.body.slice(0, 140) });
      }
    }
    return { readsThisWeek: recent.length, readers: [...byReader.values()].sort((a, b) => b.count - a.count), mentionedIn };
  });

  on("GET", `${W}/wiki-graph`, () => {
    const active = db.wikiPages.filter((p) => !p.deleted && !p.isFolder);
    const idx = titleIndex(active);
    const edges: { from: string; to: string }[] = [];
    for (const p of active) {
      for (const t of extractWikiLinks(p.body)) {
        const to = idx.get(normalizeTitle(t));
        if (to && to !== p.id) edges.push({ from: p.id, to });
      }
    }
    return { nodes: active.map((p) => ({ id: p.id, title: p.title })), edges };
  });
}
