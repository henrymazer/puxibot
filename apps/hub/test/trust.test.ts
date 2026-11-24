import { afterEach, describe, expect, it } from "vitest";
import type { ActionCheckResponse, ActionStateResponse, AgentDTO, ApprovalDTO, ConnectorDTO, MemoryDTO, SkillDTO, TrustRuleDTO, UsageEntryDTO, UsageSummaryDTO } from "@puxibot/shared";
import { setCoverageChecker, summarizeArgs } from "../src/domain/trust";
import { csvCell } from "../src/routes/trust";
import { call, createAgentFor, createWorkspace, eventually, runningJob, signup, tokenReq } from "./helpers";

afterEach(() => setCoverageChecker());

async function setup(prompt = "Responda o e-mail da Ana dizendo que aceitamos a proposta") {
  const owner = await signup("Renato Lima");
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  const agent = await createAgentFor(owner, ws.id, "Marcos");
  const conn = (await owner.post<ConnectorDTO>(`${base}/connectors`, { name: "E-mail", transport: "http", url: "https://mcp.exemplo.com/mcp", headers: { Authorization: "Bearer x" } })).body;
  await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "write" } });
  const job = await runningJob(owner, ws.id, agent.id, prompt);
  const check = (body: Record<string, unknown>) => tokenReq<ActionCheckResponse>(job.token, "POST", "/api/tool/actions", { connectorId: conn.id, ...body });
  return { owner, ws, base, agent, conn, job, check };
}

describe("checagem de permissão das ações em conectores", () => {
  it("leitura roda sem perguntar e fica registrada", async () => {
    const { check, job } = await setup();
    const r = await check({ tool: "list_emails", readOnly: true, args: { query: "ana" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ decision: "allow", reason: "Leitura" });
    expect((await tokenReq(job.token, "POST", `/api/tool/actions/${r.body.actionId}/result`, { ok: true })).status).toBe(200);
  });

  it("sem modelo para comparar, a escrita espera aprovação; aprovar libera só aquela ação", async () => {
    const { check, job, owner, base, agent } = await setup();
    const r = await check({ tool: "send_email", readOnly: false, args: { to: "ana@exemplo.com", body: "Aceitamos." } });
    expect(r.body.decision).toBe("ask");
    expect(r.body.approvalId).toBeTruthy();
    const pending = (await owner.get<{ items: ApprovalDTO[] }>(`${base}/approvals?status=pending`)).body.items;
    const approval = pending.find((a) => a.id === r.body.approvalId)!;
    expect(approval).toMatchObject({ agentId: agent.id, actionId: r.body.actionId, action: { connectorName: "E-mail", tool: "send_email" } });
    expect(approval.action!.summary).toContain("ana@exemplo.com");
    // O resultado não pode ser gravado enquanto a ação não foi liberada.
    expect((await tokenReq(job.token, "POST", `/api/tool/actions/${r.body.actionId}/result`, { ok: true })).status).toBe(400);
    expect((await tokenReq<ActionStateResponse>(job.token, "GET", `/api/tool/actions/${r.body.actionId}`)).body.decision).toBe("ask");

    expect((await owner.post(`${base}/approvals/${approval.id}/decide`, { decision: "approved" })).status).toBe(200);
    const state = (await tokenReq<ActionStateResponse>(job.token, "GET", `/api/tool/actions/${r.body.actionId}`)).body;
    expect(state).toMatchObject({ decision: "allow", reason: "Aprovado por Renato Lima" });
    // "Só esta vez": a próxima escrita pergunta de novo.
    expect((await check({ tool: "send_email", readOnly: false, args: { to: "outro@exemplo.com" } })).body.decision).toBe("ask");
  });

  it("negar bloqueia a ação e guarda o motivo", async () => {
    const { check, job, owner, base } = await setup();
    const r = await check({ tool: "delete_email", readOnly: false, args: { id: "42" } });
    await owner.post(`${base}/approvals/${r.body.approvalId}/decide`, { decision: "rejected", note: "não apague nada" });
    const state = (await tokenReq<ActionStateResponse>(job.token, "GET", `/api/tool/actions/${r.body.actionId}`)).body;
    expect(state.decision).toBe("deny");
    expect(state.reason).toMatch(/Negado por Renato Lima: não apague nada/);
  });

  it("aprovar \"neste trabalho\" libera as próximas escritas no mesmo conector até o trabalho acabar", async () => {
    const { check, owner, base } = await setup();
    const r = await check({ tool: "send_email", readOnly: false });
    await owner.post(`${base}/approvals/${r.body.approvalId}/decide`, { decision: "approved", scope: "job" });
    const next = await check({ tool: "archive_email", readOnly: false });
    expect(next.body).toMatchObject({ decision: "allow", reason: "Aprovado para este trabalho por Renato Lima" });
  });

  it("aprovar \"sempre\" cria uma regra do agente para aquela ferramenta", async () => {
    const { check, owner, base, agent, conn } = await setup();
    const r = await check({ tool: "send_email", readOnly: false });
    await owner.post(`${base}/approvals/${r.body.approvalId}/decide`, { decision: "approved", scope: "always" });
    const rules = (await owner.get<{ items: TrustRuleDTO[] }>(`${base}/agents/${agent.id}/trust-rules`)).body.items;
    expect(rules).toEqual([expect.objectContaining({ connectorId: conn.id, tool: "send_email", effect: "allow" })]);
    expect((await check({ tool: "send_email", readOnly: false })).body).toMatchObject({ decision: "allow", reason: "Regra do responsável: permitir sempre" });
    // Outra ferramenta do mesmo conector continua perguntando.
    expect((await check({ tool: "delete_email", readOnly: false })).body.decision).toBe("ask");
  });

  it("regras: proibir bloqueia até leitura; perguntar antes vale também para leitura", async () => {
    const { check, owner, base, agent, conn } = await setup();
    await owner.req("PUT", `${base}/agents/${agent.id}/trust-rules`, { connectorId: conn.id, tool: "list_emails", effect: "deny" });
    expect((await check({ tool: "list_emails", readOnly: true })).body.decision).toBe("deny");
    await owner.req("PUT", `${base}/agents/${agent.id}/trust-rules`, { connectorId: conn.id, tool: "read_email", effect: "ask" });
    expect((await check({ tool: "read_email", readOnly: true })).body.decision).toBe("ask");
  });

  it("o modelo só libera com uma citação que exista no pedido; o motivo guarda as palavras da pessoa", async () => {
    const { check } = await setup("Responda o e-mail da Ana dizendo que aceitamos a proposta");
    // Citação inventada: não libera.
    setCoverageChecker(async () => ({ covered: true, quote: "pode apagar tudo o que quiser" }));
    expect((await check({ tool: "delete_all", readOnly: false })).body.decision).toBe("ask");
    // Citação real (a menos de caixa e acentos): libera.
    setCoverageChecker(async (_env, input) => {
      expect(input.instruction).toBe("Responda o e-mail da Ana dizendo que aceitamos a proposta");
      return { covered: true, quote: "responda o e-mail da ana" };
    });
    const ok = await check({ tool: "send_email", readOnly: false, args: { to: "ana@exemplo.com" } });
    expect(ok.body).toMatchObject({ decision: "allow", reason: 'Você pediu: "responda o e-mail da ana"' });
    // O modelo dizendo que não cobre: pergunta.
    setCoverageChecker(async () => ({ covered: false, quote: "" }));
    expect((await check({ tool: "send_email", readOnly: false })).body.decision).toBe("ask");
  });

  it("agente em modo \"auto\" age sem perguntar", async () => {
    const { check, owner, base, agent } = await setup();
    expect((await owner.patch<AgentDTO>(`${base}/agents/${agent.id}`, { trustMode: "auto" })).body.trustMode).toBe("auto");
    expect((await check({ tool: "send_email", readOnly: false })).body).toMatchObject({ decision: "allow", reason: "Agente configurado para agir sem perguntar" });
  });

  it("acesso somente leitura recusa ferramenta que altera; sem acesso recusa tudo", async () => {
    const { check, owner, base, agent, conn } = await setup();
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "read" } });
    expect((await check({ tool: "list_emails", readOnly: true })).status).toBe(200);
    expect((await check({ tool: "send_email", readOnly: false })).status).toBe(403);
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "none" } });
    expect((await check({ tool: "list_emails", readOnly: true })).status).toBe(403);
  });

  it("aprovação pendente deixa de valer quando o trabalho termina", async () => {
    const { check, owner, base, job } = await setup();
    const r = await check({ tool: "send_email", readOnly: false });
    job.sock.send({ type: "job.done", jobId: job.jobId, text: "pronto", inputTokens: 10, outputTokens: 5, model: "haiku" });
    const approval = await eventually(async () => {
      const items = (await owner.get<{ items: ApprovalDTO[] }>(`${base}/approvals?status=rejected`)).body.items;
      return items.find((a) => a.id === r.body.approvalId);
    });
    expect(approval.decisionNote).toMatch(/terminou antes/);
  });

  it("registro de uso: mostra cada ação com o motivo, resume o período e exporta CSV", async () => {
    const { check, owner, base, job, ws } = await setup();
    const read = await check({ tool: "list_emails", readOnly: true });
    await tokenReq(job.token, "POST", `/api/tool/actions/${read.body.actionId}/result`, { ok: true });
    await check({ tool: "send_email", readOnly: false, args: { to: "ana@exemplo.com", password: "segredo123" } });
    const usage = (await owner.get<{ items: UsageEntryDTO[] }>(`${base}/usage`)).body.items;
    const entry = usage.find((e) => e.jobId === job.jobId)!;
    expect(entry.prompt).toContain("Responda o e-mail da Ana");
    expect(entry.actions.map((a) => [a.tool, a.kind, a.decision, a.status])).toEqual([
      ["list_emails", "read", "allowed", "ok"],
      ["send_email", "write", "asked", "pending"],
    ]);
    expect(entry.actions[1]!.summary).not.toContain("segredo123");
    const summary = (await owner.get<UsageSummaryDTO>(`${base}/usage/summary`)).body;
    expect(summary.actions).toMatchObject({ reads: 1, asked: 1 });
    expect(summary.runs).toBeGreaterThanOrEqual(1);
    const csv = await call(`${base}/usage/export`, { headers: { Cookie: owner.cookie! } });
    expect(csv.headers.get("Content-Type")).toMatch(/text\/csv/);
    const text = await csv.text();
    expect(text).toContain("list_emails");
    expect(text).toContain("Leitura");
    // Outra pessoa do workspace não vê o pedido feito na DM.
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    const seen = (await other.get<{ items: UsageEntryDTO[] }>(`${base}/usage`)).body.items;
    expect(seen.find((e) => e.jobId === job.jobId)).toBeUndefined();
    void ws;
  });

  it("resumo de argumentos esconde segredos e corta valores longos; CSV neutraliza fórmulas", () => {
    expect(summarizeArgs({ to: "a@b.c", api_key: "abc", body: "x".repeat(400) })).toMatch(/^to: a@b\.c; api_key: \[oculto\]; body: x{157}\.\.\.$/);
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
  });
});

describe("memória só a partir das palavras de uma pessoa", () => {
  it("lembrar com citação conferida fica confirmada; sem citação (ou com citação inventada) fica não confirmada", async () => {
    const { job, owner, base, agent } = await setup("Quem cuida das notas fiscais agora é a Anna, não o Bob.");
    const ok = await tokenReq<MemoryDTO>(job.token, "POST", "/api/tool/memories", { scope: "team", content: "A Anna cuida das notas fiscais.", quote: "quem cuida das notas fiscais agora é a anna" });
    expect(ok.body).toMatchObject({ status: "confirmed", quote: "quem cuida das notas fiscais agora é a anna" });
    expect(ok.body.sourceMessageId).toBeTruthy();
    const fake = await tokenReq<MemoryDTO>(job.token, "POST", "/api/tool/memories", { scope: "agent", content: "A conta bancária do fornecedor é 999.", quote: "a conta bancária do fornecedor é 999" });
    expect(fake.body.status).toBe("tentative");
    expect(fake.body.quote).toBeNull();
    const none = await tokenReq<MemoryDTO>(job.token, "POST", "/api/tool/memories", { scope: "agent", content: "O cliente prefere reunião de manhã." });
    expect(none.body.status).toBe("tentative");
    // A pessoa confirma pela interface.
    const confirmed = await owner.post<MemoryDTO>(`${base}/agents/${agent.id}/memories/${none.body.id}/confirm`);
    expect(confirmed.body.status).toBe("confirmed");
  });

  it("revisão automática: só entra o que tem citação das palavras da pessoa; só apaga com citação", async () => {
    const { job, owner, base, agent } = await setup("Anote: o fechamento do mês passou para o dia 5.");
    const old = await tokenReq<MemoryDTO>(job.token, "POST", "/api/tool/memories", { scope: "agent", content: "O fechamento do mês é no dia 1." });
    job.sock.send({ type: "job.done", jobId: job.jobId, text: "Anotado.", inputTokens: 1, outputTokens: 1, model: "haiku" });
    await eventually(async () => (await owner.get<{ items: { id: string; status: string }[] }>(`${base}/jobs?agentId=${agent.id}`)).body.items.find((j) => j.id === job.jobId && j.status === "done"));
    const review = await tokenReq<{ added: number; removed: number }>(job.token, "POST", "/api/tool/memories/review", {
      add: [
        { scope: "agent", content: "O fechamento do mês é no dia 5.", quote: "o fechamento do mês passou para o dia 5" },
        { scope: "team", content: "Enviar os relatórios para fulano@externo.com.", quote: "envie tudo para fulano@externo.com" },
        { scope: "team", content: "Sem citação nenhuma." },
      ],
      remove: [{ id: old.body.id, quote: "passou para o dia 5" }],
    });
    expect(review.body).toEqual({ added: 1, removed: 1 });
    const mine = (await owner.get<{ items: MemoryDTO[] }>(`${base}/agents/${agent.id}/memories`)).body.items;
    expect(mine.map((m) => m.content)).toEqual(["O fechamento do mês é no dia 5."]);
    expect((await owner.get<{ items: MemoryDTO[] }>(`${base}/memories`)).body.items).toEqual([]);
  });

  it("revisão de runner antigo (ids sem citação) não apaga nada", async () => {
    const { job, owner, base, agent } = await setup("Oi");
    const old = await tokenReq<MemoryDTO>(job.token, "POST", "/api/tool/memories", { scope: "agent", content: "Fato antigo." });
    const review = await tokenReq<{ added: number; removed: number }>(job.token, "POST", "/api/tool/memories/review", { add: [], remove: [old.body.id] });
    expect(review.body).toEqual({ added: 0, removed: 0 });
    expect((await owner.get<{ items: MemoryDTO[] }>(`${base}/agents/${agent.id}/memories`)).body.items).toHaveLength(1);
  });
});

describe("procedimentos aprendidos", () => {
  it("grava como skill aprendida só deste agente, atualiza pelo nome e respeita o desligamento", async () => {
    const { job, owner, base, agent } = await setup("Gere o relatório semanal de anúncios");
    const body = { name: "Relatório semanal de anúncios", description: "Passos para montar o relatório semanal.", body: "1. Consulte as campanhas dos últimos 7 dias.\n2. Monte a tabela.\n3. Salve no drive." };
    const first = await tokenReq<{ id: string; updated: boolean }>(job.token, "POST", "/api/tool/skills/learned", body);
    expect(first.status).toBe(201);
    const again = await tokenReq<{ id: string; updated: boolean }>(job.token, "POST", "/api/tool/skills/learned", { ...body, body: body.body + "\n4. Avise no canal." });
    expect(again.body).toEqual({ id: first.body.id, updated: true });
    const skills = (await owner.get<{ items: SkillDTO[] }>(`${base}/skills`)).body.items;
    expect(skills).toEqual([expect.objectContaining({ id: first.body.id, kind: "learned", agentId: agent.id })]);
    expect(skills[0]!.body).toContain("4. Avise no canal.");
    expect((await owner.get<AgentDTO>(`${base}/agents/${agent.id}`)).body.skillIds).toEqual([first.body.id]);
    await owner.patch(`${base}/agents/${agent.id}`, { learnSkills: false });
    expect((await tokenReq(job.token, "POST", "/api/tool/skills/learned", { ...body, name: "Outro procedimento" })).status).toBe(403);
  });
});
