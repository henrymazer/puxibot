/** Tarefas no modo demonstração. */
import { extractMentions, type ActorRef, type MessageDTO, type TaskCommentDTO, type TaskDTO } from "@puxibot/shared";
import { HttpError, type DemoContext, type DemoDb } from "../backend";
import type { AreaDb } from "../seedAreas";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function seedTasks(base: DemoDb): Pick<AreaDb, "tasks" | "taskComments" | "taskSeq"> {
  const now = Date.now();
  const ana = base.user.id;
  const [, bruno, carla, diego] = base.members.map((m) => m.userId);
  let n = 0;
  const t = (p: Partial<TaskDTO> & Pick<TaskDTO, "title">): TaskDTO => {
    n++;
    return {
      id: `tsk_seed_${n}`,
      number: 100 + n,
      description: "",
      status: "todo",
      priority: "medium",
      labels: [],
      project: null,
      assignee: null,
      subtasks: [],
      links: [],
      sourceMessageId: null,
      createdBy: { type: "user", id: ana },
      commentCount: 0,
      position: n * 1024,
      createdAt: now - (20 - n) * DAY,
      updatedAt: now - (10 - (n % 5)) * HOUR,
      ...p,
    };
  };
  const agent = (id: string): ActorRef => ({ type: "agent", id });
  const user = (id: string | undefined): ActorRef => ({ type: "user", id: id ?? ana });
  const tasks: TaskDTO[] = [
    t({
      title: "Revisar o PR #128 do login",
      description: "Diego abriu o PR com a correção do login no Safari.\n\n- Conferir testes\n- Ver nomes de variáveis\n\nVeja também a página [[Processo de deploy]].",
      status: "review",
      priority: "high",
      labels: ["código", "urgente"],
      project: "App",
      assignee: agent("agt_theo"),
      links: [{ kind: "pr", label: "#128", url: "https://github.com/exemplo/app/pull/128" }],
      subtasks: [
        { id: "st1", title: "Rodar os testes", done: true },
        { id: "st2", title: "Comentar nomes", done: false },
      ],
      commentCount: 2,
    }),
    t({ title: "Newsletter de dezembro", description: "Rascunho com o título \"Fim de ano sem correria\".", status: "doing", priority: "medium", labels: ["marketing"], project: "Campanhas", assignee: agent("agt_lia"), updatedAt: now - 3 * DAY - HOUR }),
    t({ title: "Fechar o caixa de novembro", status: "doing", priority: "high", labels: ["financeiro"], project: "Interno", assignee: agent("agt_nina"), updatedAt: now - 2 * DAY - HOUR }),
    t({ title: "Atualizar o contrato da Padaria Sol", status: "todo", priority: "high", labels: ["clientes"], project: "Clientes", assignee: user(ana) }),
    t({ title: "Trocar o alerta de memória para 85%", status: "todo", priority: "low", labels: ["infra"], project: "App", assignee: null, sourceMessageId: null }),
    t({ title: "Montar apresentação para a Loja Vento", status: "todo", priority: "medium", labels: ["clientes"], project: "Clientes", assignee: user(bruno) }),
    t({ title: "Documentar o processo de deploy na wiki", status: "doing", priority: "medium", labels: ["infra", "wiki"], project: "App", assignee: user(diego), updatedAt: now - 5 * HOUR }),
    t({ title: "Posts da semana no Instagram", status: "done", priority: "low", labels: ["marketing"], project: "Campanhas", assignee: agent("agt_lia") }),
    t({ title: "Corrigir bug do login no Safari", status: "done", priority: "high", labels: ["código"], project: "App", assignee: agent("agt_theo"), links: [{ kind: "issue", label: "#119", url: "https://github.com/exemplo/app/issues/119" }] }),
    t({ title: "Pesquisar ferramenta de nota fiscal", status: "todo", priority: "low", labels: ["financeiro"], project: "Interno", assignee: user(carla) }),
  ];
  const c1 = tasks[0]!;
  const taskComments: TaskCommentDTO[] = [
    { id: "tcm_1", taskId: c1.id, author: user(diego), body: "Subi a correção. @tito pode revisar?", createdAt: now - 6 * HOUR },
    { id: "tcm_2", taskId: c1.id, author: agent("agt_theo"), body: "Revisei. Os testes passam; deixei dois comentários sobre nomes.", createdAt: now - 5 * HOUR, onBehalfOfUserId: diego },
  ];
  return { tasks, taskComments, taskSeq: 100 + n };
}

export function registerTasks(ctx: DemoContext): void {
  const { db, on, emit, W } = ctx;
  const find = (id: string) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) throw new HttpError(404, "not_found", "Tarefa não encontrada.");
    return t;
  };
  const publish = (t: TaskDTO) => emit({ type: "task.upserted", task: { ...t } });

  /** Atribuir a um agente (ou mencioná-lo num comentário) cria um trabalho para ele. */
  const startAgent = (t: TaskDTO, agentId: string, why: string) => {
    const agent = db.agents.find((a) => a.id === agentId);
    if (!agent || agent.status === "paused") return;
    const fake: MessageDTO = {
      id: `virtual_${t.id}`,
      channelId: "",
      author: { type: "user", id: db.user.id },
      body: `${why}: #${t.number} ${t.title}`,
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
      createdAt: Date.now(),
    };
    void ctx.runJob(agent, fake, { channelId: null, taskId: t.id });
  };

  on("GET", `${W}/tasks`, ({ query }) => {
    let list = db.tasks.slice();
    const st = query.get("status");
    const as = query.get("assignee");
    const pr = query.get("project");
    const lb = query.get("label");
    const q = (query.get("q") ?? "").toLowerCase();
    if (st) list = list.filter((t) => t.status === st);
    if (as) list = list.filter((t) => (as === "none" ? !t.assignee : `${t.assignee?.type}:${t.assignee?.id}` === as));
    if (pr) list = list.filter((t) => t.project === pr);
    if (lb) list = list.filter((t) => t.labels.includes(lb));
    if (q) list = list.filter((t) => `#${t.number} ${t.title} ${t.description}`.toLowerCase().includes(q));
    return { items: list };
  });

  on(
    "POST",
    `${W}/tasks`,
    ({ body }) => {
      const title = String(body.title ?? "").trim();
      if (!title) throw new HttpError(400, "invalid", "Dê um título à tarefa.");
      const now = Date.now();
      const status = body.status ?? "todo";
      const col = db.tasks.filter((t) => t.status === status);
      const t: TaskDTO = {
        id: ctx.id("tsk"),
        number: ++db.taskSeq,
        title,
        description: body.description ?? "",
        status,
        priority: body.priority ?? "medium",
        labels: body.labels ?? [],
        project: body.project || null,
        assignee: body.assignee ?? null,
        subtasks: [],
        links: [],
        sourceMessageId: body.sourceMessageId ?? null,
        createdBy: { type: "user", id: db.user.id },
        commentCount: 0,
        // Novas entram no topo da coluna.
        position: col.length ? Math.min(...col.map((x) => x.position)) - 1024 : 1024,
        createdAt: now,
        updatedAt: now,
      };
      db.tasks.push(t);
      publish(t);
      if (t.assignee?.type === "agent") startAgent(t, t.assignee.id, "Nova tarefa para você");
      return t;
    },
    201,
  );

  on("GET", `${W}/tasks/:id`, ({ m }) => find(m[2]!));

  on("PATCH", `${W}/tasks/:id`, async ({ m, body }) => {
    await ctx.sleep(120);
    const t = find(m[2]!);
    const before = t.assignee;
    const allowed = ["title", "description", "status", "priority", "labels", "project", "assignee", "subtasks", "links", "position"] as const;
    for (const k of allowed) if (k in body) (t as unknown as Record<string, unknown>)[k] = body[k];
    if (body.title !== undefined && !String(body.title).trim()) throw new HttpError(400, "invalid", "O título não pode ficar vazio.");
    t.updatedAt = Date.now();
    publish(t);
    const now = t.assignee;
    if (now?.type === "agent" && (before?.type !== "agent" || before.id !== now.id)) startAgent(t, now.id, "Tarefa atribuída a você");
    return t;
  });

  on("DELETE", `${W}/tasks/:id`, ({ m }) => {
    find(m[2]!);
    db.tasks = db.tasks.filter((x) => x.id !== m[2]);
    db.taskComments = db.taskComments.filter((c) => c.taskId !== m[2]);
    emit({ type: "task.deleted", taskId: m[2]! });
  });

  on("GET", `${W}/tasks/:id/comments`, ({ m }) => ({
    items: db.taskComments.filter((c) => c.taskId === m[2]).sort((a, b) => a.createdAt - b.createdAt),
  }));

  on(
    "POST",
    `${W}/tasks/:id/comments`,
    ({ m, body }) => {
      const t = find(m[2]!);
      const text = String(body.body ?? "").trim();
      if (!text) throw new HttpError(400, "invalid", "Escreva o comentário.");
      const c: TaskCommentDTO = { id: ctx.id("tcm"), taskId: t.id, author: { type: "user", id: db.user.id }, body: text, createdAt: Date.now() };
      db.taskComments.push(c);
      t.commentCount++;
      t.updatedAt = Date.now();
      publish(t);
      for (const h of extractMentions(text)) {
        const a = db.agents.find((x) => x.handle === h);
        if (a) startAgent(t, a.id, "Você foi mencionado num comentário");
      }
      // Resposta simulada do agente responsável, para o painel ganhar vida.
      if (t.assignee?.type === "agent" && /@/.test(text)) {
        const agentId = t.assignee.id;
        setTimeout(() => {
          const reply: TaskCommentDTO = {
            id: ctx.id("tcm"),
            taskId: t.id,
            author: { type: "agent", id: agentId },
            body: "Combinado, já estou olhando e aviso aqui quando terminar.",
            createdAt: Date.now(),
            onBehalfOfUserId: db.user.id,
          };
          db.taskComments.push(reply);
          t.commentCount++;
          t.updatedAt = Date.now();
          publish(t);
        }, 2500);
      }
      return c;
    },
    201,
  );

  on("POST", `${W}/tasks/resume-stalled`, () => {
    const now = Date.now();
    const stalled = db.tasks.filter((t) => t.status === "doing" && now - t.updatedAt > DAY && t.assignee?.type === "agent");
    for (const t of stalled) {
      t.updatedAt = now;
      publish(t);
      startAgent(t, t.assignee!.id, "Continuar a tarefa parada");
    }
    return { count: stalled.length };
  });
}
