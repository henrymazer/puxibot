import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ChannelDTO, JobDTO, MessageDTO, RoutineDTO } from "@puxibot/shared";
import { nextCronRun } from "../src/lib/cron";
import { bootstrap, createAgentFor, createWorkspace, eventually, signup } from "./helpers";

async function setup() {
  const owner = await signup("Renato Lima");
  const ws = await createWorkspace(owner);
  return { owner, ws, base: `/api/workspaces/${ws.id}` };
}

const stubFor = (wsId: string) => env.WORKSPACE_HUB.getByName(wsId);

describe("rotinas", () => {
  it("assistente nasce com rotina daily_summary às 9h de São Paulo com next_run_at calculado, e o alarme fica agendado", async () => {
    const { owner, ws, base } = await setup();
    const list = await owner.get<{ items: RoutineDTO[] }>(`${base}/routines`);
    const daily = list.body.items.find((r) => r.kind === "daily_summary")!;
    expect(daily).toMatchObject({ cron: "0 9 * * *", timezone: "America/Sao_Paulo", enabled: true });
    expect(daily.nextRunAt).toBe(nextCronRun("0 9 * * *", "America/Sao_Paulo", daily.nextRunAt! - 86_400_000 + 1));
    expect(new Date(daily.nextRunAt!).getUTCHours()).toBe(12);
    const alarm = await eventually(async () => runInDurableObject(stubFor(ws.id), (_i, state) => state.storage.getAlarm()));
    expect(alarm).toBe(daily.nextRunAt);
  });

  it("backfill: rotina com next_run_at nulo ganha horário quando o hub acorda", async () => {
    const { ws } = await setup();
    await env.DB.prepare("UPDATE routines SET next_run_at = NULL WHERE workspace_id = ?").bind(ws.id).run();
    await stubFor(ws.id).pump(ws.id);
    const row = await env.DB.prepare("SELECT next_run_at FROM routines WHERE workspace_id = ?").bind(ws.id).first<{ next_run_at: number | null }>();
    expect(row?.next_run_at).toBeGreaterThan(Date.now());
  });

  it("CRUD com validação de cron/fuso; custom dispara pelo alarme no horário certo e cria job origin=routine", async () => {
    const { owner, ws, base } = await setup();
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    await owner.patch(`${base}/agents/${agent.id}`, { selfStartPolicy: "run" });
    const general = (await bootstrap(owner, ws.id)).channels.find((c) => c.name === "general")!;
    expect((await owner.post(`${base}/routines`, { agentId: agent.id, name: "x", cron: "0 25 * * *" })).status).toBe(400);
    expect((await owner.post(`${base}/routines`, { agentId: agent.id, name: "x", cron: "0 9 * * *", timezone: "Lua/Base" })).status).toBe(400);
    const t0 = Date.now();
    const created = await owner.post<RoutineDTO>(`${base}/routines`, {
      agentId: agent.id,
      name: "Resumo de PRs",
      prompt: "Resuma PRs e issues",
      cron: "4 9 * * 1-5",
      timezone: "America/New_York",
      channelId: general.id,
    });
    expect(created.status).toBe(201);
    // O hub calculou entre t0 e agora: o próximo horário é o de um desses instantes (sem depender de quanto demorou).
    expect([nextCronRun("4 9 * * 1-5", "America/New_York", t0), nextCronRun("4 9 * * 1-5", "America/New_York", Date.now())]).toContain(
      created.body.nextRunAt,
    );
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" }).format(created.body.nextRunAt!);
    expect(local).toMatch(/(Mon|Tue|Wed|Thu|Fri) 09:04/);

    // O alarme fica agendado no next_run_at da rotina. Usa um horário 1 h à frente (o alarme real não dispara
    // sozinho durante o teste, mesmo com a máquina lenta) e confere que o hub agendou exatamente ele.
    // O resumo diário do assistente (9h de São Paulo) poderia ser o alarme mais próximo dependendo da hora: desliga.
    await env.DB.prepare("UPDATE routines SET enabled = 0 WHERE workspace_id = ? AND kind = 'daily_summary'").bind(ws.id).run();
    const soon = Date.now() + 60 * 60_000;
    await env.DB.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").bind(soon, created.body.id).run();
    await stubFor(ws.id).pump(ws.id);
    expect(await runInDurableObject(stubFor(ws.id), (_i, state) => state.storage.getAlarm())).toBe(soon);
    // "Chega a hora": a rotina venceu (sem `pump`, o alarme continua lá na frente) e o alarme roda agora.
    const due = Date.now() - 1000;
    await env.DB.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").bind(due, created.body.id).run();
    expect(await runDurableObjectAlarm(stubFor(ws.id))).toBe(true);
    const jobs = (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agent.id}`)).body.items;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ origin: "routine", routineId: created.body.id, channelId: general.id, status: "queued" });
    expect(jobs[0]!.prompt).toContain("Resuma PRs e issues");
    const after = (await owner.get<RoutineDTO>(`${base}/routines/${created.body.id}`)).body;
    expect(after.lastRunAt).toBeGreaterThan(due);
    expect(after.nextRunAt).toBe(nextCronRun("4 9 * * 1-5", "America/New_York", after.lastRunAt!));
    // Alarme de novo não repete (o próximo alarme agendado é o próximo horário, no futuro).
    expect(await runInDurableObject(stubFor(ws.id), (_i, state) => state.storage.getAlarm())).toBeGreaterThan(Date.now());
    await runDurableObjectAlarm(stubFor(ws.id));
    expect((await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agent.id}`)).body.items).toHaveLength(1);

    // Política "ask": nasce awaiting_approval.
    await owner.patch(`${base}/agents/${agent.id}`, { selfStartPolicy: "ask" });
    await env.DB.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").bind(Date.now() - 1000, created.body.id).run();
    expect(await runDurableObjectAlarm(stubFor(ws.id))).toBe(true);
    const asked = (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agent.id}&status=awaiting_approval`)).body.items;
    expect(asked).toHaveLength(1);

    // Executar agora (pedido da pessoa): não pede aprovação.
    const ran = await owner.post<{ job: JobDTO }>(`${base}/routines/${created.body.id}/run`);
    expect(ran.body.job).toMatchObject({ status: "queued", origin: "user", requestedByUserId: owner.userId, routineId: created.body.id });

    const patched = await owner.patch<RoutineDTO>(`${base}/routines/${created.body.id}`, { enabled: false });
    expect(patched.body).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await owner.del(`${base}/routines/${created.body.id}`)).status).toBe(204);
  });

  it("resumo diário: o hub monta o cartão stats e o checklist 'Precisa de você' na DM, sem runner e sem job", async () => {
    const { owner, ws, base } = await setup();
    const agent = await createAgentFor(owner, ws.id, "Marcos");
    // Dados das últimas 24 h: 1 tarefa concluída, 1 job falho, 1 aprovação pendente, 1 job esperando runner.
    await owner.post(`${base}/tasks`, { title: "Entregar relatório", status: "done", assignee: { type: "user", id: owner.userId } });
    const dm = await owner.post<ChannelDTO>(`${base}/dms`, { with: { type: "agent", id: agent.id } });
    await owner.post(`${base}/channels/${dm.body.id}/messages`, { body: "faz algo" }); // fica esperando runner
    await eventually(async () => (await owner.get<{ items: JobDTO[] }>(`${base}/jobs?agentId=${agent.id}`)).body.items[0]?.waitingForRunner);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs (id, workspace_id, agent_id, origin, prompt, status, error, error_code, created_at, finished_at)
       VALUES (?, ?, ?, 'user', 'x', 'failed', 'quebrou', 'error', ?, ?)`,
    )
      .bind(crypto.randomUUID(), ws.id, agent.id, now - 1000, now - 500)
      .run();
    await env.DB.prepare(
      `INSERT INTO approvals (id, workspace_id, agent_id, kind, title, approver_user_id, status, created_at)
       VALUES (?, ?, ?, 'action', 'Gastar R$ 50', ?, 'pending', ?)`,
    )
      .bind(crypto.randomUUID(), ws.id, agent.id, owner.userId, now)
      .run();

    const routine = (await owner.get<{ items: RoutineDTO[] }>(`${base}/routines`)).body.items.find((r) => r.kind === "daily_summary")!;
    const jobsBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ?").bind(ws.id).first<{ n: number }>())!.n;
    // Sem `pump` depois de vencer a rotina: o alarme agendado continua no futuro (não dispara sozinho no meio do
    // teste) e `runDurableObjectAlarm` o executa agora, de forma determinística.
    await stubFor(ws.id).pump(ws.id);
    expect(await runInDurableObject(stubFor(ws.id), (_i, state) => state.storage.getAlarm())).toBeGreaterThan(Date.now());
    await env.DB.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").bind(Date.now() - 1000, routine.id).run();
    expect(await runDurableObjectAlarm(stubFor(ws.id))).toBe(true);

    const msgs = (await owner.get<{ items: MessageDTO[] }>(`${base}/channels/${routine.channelId}/messages`)).body.items;
    const summary = msgs.find((m) => m.author.type === "agent" && m.cards.length === 2)!;
    expect(summary.author.id).toBe(routine.agentId);
    expect(summary.body).toContain("#1 Entregar relatório");
    const stats = summary.cards.find((c) => c.type === "stats");
    expect(stats).toMatchObject({
      items: [
        { label: "Tarefas concluídas", value: "1" },
        { label: "Jobs que falharam", value: "1" },
        { label: "Esperando você", value: "3" },
      ],
    });
    const checklist = summary.cards.find((c) => c.type === "checklist") as Extract<MessageDTO["cards"][number], { type: "checklist" }>;
    expect(checklist.title).toBe("Precisa de você");
    expect(checklist.items.map((i) => i.label)).toEqual(["Aprovar: Gastar R$ 50", "Marcos parou com um erro", "Marcos está esperando um computador ligado"]);
    expect(checklist.items[0]!.link).toBe(`/w/${ws.id}/aprovacoes`);
    const jobsAfter = (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ?").bind(ws.id).first<{ n: number }>())!.n;
    expect(jobsAfter).toBe(jobsBefore);

    // Também pelo "executar agora".
    const ran = await owner.post<{ kind: string; job: null; messageId: string }>(`${base}/routines/${routine.id}/run`);
    expect(ran.body).toMatchObject({ kind: "daily_summary", job: null });
    expect(ran.body.messageId).toBeTruthy();
  });
});
