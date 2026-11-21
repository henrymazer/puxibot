import { describe, expect, it } from "vitest";
import type { AgentDTO, ApprovalDTO, RunnerDTO } from "@puxibot/shared";
import { job, task } from "../../test/fixtures";
import { mergeJobs, summarizeHome } from "./summary";

const now = 10 * 86400_000;
const agent = (id: string, owner: string) => ({ id, ownerUserId: owner }) as AgentDTO;
const approval = (id: string, approver: string, status: ApprovalDTO["status"] = "pending") =>
  ({ id, approverUserId: approver, status, createdAt: 1, title: id }) as ApprovalDTO;
const runner = (userId: string, online: boolean) => ({ id: `r-${userId}`, userId, online }) as RunnerDTO;
const base = { jobs: [], approvals: [], runners: [], agents: [], myUserId: "u1", admin: false, now };

describe("summarizeHome", () => {
  it("aprovações: as minhas, ou todas para admin", () => {
    const approvals = [approval("a", "u1"), approval("b", "u2"), approval("c", "u1", "approved")];
    expect(summarizeHome({ ...base, approvals }).approvals.map((a) => a.id)).toEqual(["a"]);
    expect(summarizeHome({ ...base, approvals, admin: true }).approvals.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("erros recentes de pedidos meus ou dos meus agentes, mais novos primeiro", () => {
    const jobs = [
      job({ id: "1", status: "failed", requestedByUserId: "u1", finishedAt: now - 1000 }),
      job({ id: "2", status: "failed", requestedByUserId: "u2", agentId: "mine", finishedAt: now - 10 }),
      job({ id: "3", status: "failed", requestedByUserId: "u2", agentId: "other", finishedAt: now - 10 }),
      job({ id: "4", status: "failed", requestedByUserId: "u1", finishedAt: now - 4 * 86400_000 }),
    ];
    const s = summarizeHome({ ...base, jobs, agents: [agent("mine", "u1"), agent("other", "u2")] });
    expect(s.failed.map((j) => j.id)).toEqual(["2", "1"]);
  });

  it("avisa sem computador ligado só quando algo depende de mim", () => {
    expect(summarizeHome(base).runnerWarning).toBeNull();
    const waiting = [job({ id: "w", status: "queued", waitingForRunner: true, requestedByUserId: "u1" })];
    expect(summarizeHome({ ...base, jobs: waiting }).runnerWarning).toEqual({ hasRunner: false, waiting: 1, ownedAgents: 0 });
    expect(summarizeHome({ ...base, agents: [agent("a", "u1")], runners: [runner("u1", false)] }).runnerWarning).toEqual({ hasRunner: true, waiting: 0, ownedAgents: 1 });
    expect(summarizeHome({ ...base, jobs: waiting, runners: [runner("u1", true)] }).runnerWarning).toBeNull();
  });

  it("atividade recente e tarefas minhas ordenadas", () => {
    const act = summarizeHome.recentActivity(
      [job({ id: "q", status: "queued", createdAt: 9 }), job({ id: "d", status: "done", finishedAt: 5 }), job({ id: "r", status: "running", startedAt: 7 })],
      5,
    );
    expect(act.map((j) => j.id)).toEqual(["r", "d"]);
    const me = { type: "user" as const, id: "u1" };
    const t = summarizeHome.myTasks(
      [
        task({ id: "a", status: "todo", priority: "low", assignee: me }),
        task({ id: "b", status: "doing", assignee: me }),
        task({ id: "c", status: "todo", priority: "high", assignee: me }),
        task({ id: "d", status: "done", assignee: me }),
        task({ id: "e", status: "todo", assignee: { type: "agent", id: "x" } }),
      ],
      "u1",
      2,
    );
    expect(t.items.map((x) => x.id)).toEqual(["b", "c"]);
    expect(t.more).toBe(1);
  });

  it("mergeJobs prefere a versão em tempo real", () => {
    expect(mergeJobs([job({ id: "1", status: "queued" })], [job({ id: "1", status: "done" })])[0]!.status).toBe("done");
  });
});
