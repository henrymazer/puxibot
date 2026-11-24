import { describe, expect, it } from "vitest";
import type { ActionCheckResponse, ApprovalDTO, ConnectorDTO, VaultItemDTO } from "@puxibot/shared";
import { replaceSecret, singleSecretSlot } from "../src/domain/secretRequests";
import { connectRunner, createAgentFor, createRunnerToken, createWorkspace, runningJob, signup, tokenReq } from "./helpers";

async function setup() {
  const owner = await signup("Renata Lima");
  const ws = await createWorkspace(owner);
  const base = `/api/workspaces/${ws.id}`;
  const agent = await createAgentFor(owner, ws.id, "Marcos");
  const runner = await connectRunner(await createRunnerToken(owner, ws.id), ws.id, { capacity: 4 });
  return { owner, ws, base, agent, runner };
}

const SENHA = "S3nh@-que-ninguem-ve";

describe("pedido de segredo", () => {
  it("login de site: a pessoa digita, o valor vai para o cofre dela e o agente só vê o estado", async () => {
    const { owner, ws, base, agent, runner } = await setup();
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { browser: "write" } });
    const job = await runningJob(owner, ws.id, agent.id, "entre no painel da transportadora", runner);
    expect(job.assignment.vault).toEqual([]);

    const asked = await tokenReq<ApprovalDTO>(job.token, "POST", "/api/tool/secret-requests", {
      label: "Senha da transportadora",
      reason: "Preciso entrar no painel para baixar o relatório.",
      url: "https://painel.exemplo.com/ajuda?x=1",
      target: { kind: "vault", name: "Transportadora", site: "painel.exemplo.com/login", username: "renata@empresa.com" },
    });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({
      kind: "secret",
      status: "pending",
      approverUserId: owner.userId,
      secret: { target: "vault", name: "Transportadora", origin: "https://painel.exemplo.com", username: "renata@empresa.com", url: "https://painel.exemplo.com/ajuda?x=1" },
    });
    // Aparece na lista de pendentes de quem vai digitar.
    const pending = (await owner.get<{ items: ApprovalDTO[] }>(`${base}/approvals?status=pending`)).body.items;
    expect(pending.find((a) => a.id === asked.body.id)?.secret?.target).toBe("vault");

    // Sem valor não guarda; com valor, guarda e a resposta não o devolve.
    expect((await owner.post(`${base}/approvals/${asked.body.id}/decide`, { decision: "approved" })).status).toBe(400);
    const saved = await owner.post<ApprovalDTO>(`${base}/approvals/${asked.body.id}/decide`, { decision: "approved", secret: SENHA });
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe("approved");
    expect(JSON.stringify(saved.body)).not.toContain(SENHA);
    expect((await owner.post(`${base}/approvals/${asked.body.id}/decide`, { decision: "approved", secret: "outra" })).status).toBe(409);

    // O agente consulta o estado e nunca recebe o valor.
    const state = await tokenReq<ApprovalDTO>(job.token, "GET", `/api/tool/approvals/${asked.body.id}`);
    expect(state.body.status).toBe("approved");
    expect(JSON.stringify(state.body)).not.toContain(SENHA);

    // O login existe no cofre e vale neste mesmo trabalho, pela checagem de sempre.
    const items = (await owner.get<{ items: VaultItemDTO[] }>(`${base}/vault`)).body.items;
    expect(items).toMatchObject([{ name: "Transportadora", origin: "https://painel.exemplo.com", username: "renata@empresa.com" }]);
    expect(JSON.stringify(items)).not.toContain(SENHA);
    const use = await tokenReq<ActionCheckResponse>(job.token, "POST", "/api/tool/vault/use", { name: "Transportadora" });
    expect(use.body.decision).toBe("ask");
    await owner.post(`${base}/approvals/${use.body.approvalId}/decide`, { decision: "approved" });
    const secret = await tokenReq<{ password: string; origin: string }>(job.token, "POST", "/api/tool/vault/secret", { actionId: use.body.actionId });
    expect(secret.body).toMatchObject({ password: SENHA, origin: "https://painel.exemplo.com" });
  });

  it("um pedido novo com o mesmo nome atualiza o login; recusar não guarda nada", async () => {
    const { owner, ws, base, agent, runner } = await setup();
    const job = await runningJob(owner, ws.id, agent.id, "entre no painel", runner);
    const ask = (username?: string) =>
      tokenReq<ApprovalDTO>(job.token, "POST", "/api/tool/secret-requests", { label: "Senha", reason: "Para entrar.", target: { kind: "vault", name: "Painel", site: "https://app.exemplo.com", ...(username ? { username } : {}) } });
    const first = await ask();
    // Sem usuário no pedido, a pessoa precisa informar.
    expect((await owner.post(`${base}/approvals/${first.body.id}/decide`, { decision: "approved", secret: "a" })).status).toBe(400);
    expect((await owner.post(`${base}/approvals/${first.body.id}/decide`, { decision: "approved", secret: "a", username: "ana" })).status).toBe(200);
    const second = await ask("ana2");
    await owner.post(`${base}/approvals/${second.body.id}/decide`, { decision: "approved", secret: "b" });
    const items = (await owner.get<{ items: VaultItemDTO[] }>(`${base}/vault`)).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.username).toBe("ana2");
    const third = await ask("ana3");
    const declined = await owner.post<ApprovalDTO>(`${base}/approvals/${third.body.id}/decide`, { decision: "rejected" });
    expect(declined.body.status).toBe("rejected");
    expect((await owner.get<{ items: VaultItemDTO[] }>(`${base}/vault`)).body.items[0]!.username).toBe("ana2");
  });

  it("só quem recebeu o pedido responde, nem admin; site sem HTTPS e link inválido são recusados; há limite de pedidos", async () => {
    const { owner, ws, base, agent } = await setup();
    const invite = (await owner.post<{ code: string }>(`${base}/invites`, {})).body.code;
    const other = await signup("Bia Alves", invite);
    // Bia pede o trabalho: o login iria para o cofre dela, então só ela responde (Renata é admin e dona do agente).
    const job = await runningJob(other, ws.id, agent.id, "entre no painel");
    const target = { kind: "vault", name: "Painel", site: "https://app.exemplo.com", username: "bia" };
    const asked = await tokenReq<ApprovalDTO>(job.token, "POST", "/api/tool/secret-requests", { label: "Senha", reason: "Para entrar.", target });
    expect(asked.body.approverUserId).toBe(other.userId);
    expect((await owner.post(`${base}/approvals/${asked.body.id}/decide`, { decision: "approved", secret: "x" })).status).toBe(403);
    expect((await owner.post(`${base}/approvals/${asked.body.id}/decide`, { decision: "rejected" })).status).toBe(403);
    expect((await owner.get<{ items: VaultItemDTO[] }>(`${base}/vault`)).body.items).toEqual([]);

    const bad = (extra: Record<string, unknown>) => tokenReq(job.token, "POST", "/api/tool/secret-requests", { label: "Senha", reason: "Para entrar.", target, ...extra });
    expect((await bad({ target: { ...target, site: "http://app.exemplo.com" } })).status).toBe(400);
    expect((await bad({ url: "javascript:alert(1)" })).status).toBe(400);
    expect((await bad({ url: "http://exemplo.com" })).status).toBe(400);
    expect((await bad({})).status).toBe(201);
    expect((await bad({})).status).toBe(201);
    expect((await bad({})).status).toBe(409);
  });

  it("token de conector: troca o único segredo mantendo o formato, só pelo dono do conector", async () => {
    const { owner, ws, base, agent, runner } = await setup();
    const conn = (await owner.post<ConnectorDTO>(`${base}/connectors`, { name: "Anúncios", transport: "http", url: "https://mcp.exemplo.com/mcp", headers: { Authorization: "Bearer token-velho" } })).body;
    const job = await runningJob(owner, ws.id, agent.id, "veja as campanhas", runner);
    const ask = () => tokenReq<ApprovalDTO>(job.token, "POST", "/api/tool/secret-requests", { label: "Token novo", reason: "O token expirou.", target: { kind: "connector", connector: "anúncios" } });
    // O agente ainda não tem acesso ao conector: não pode pedir o token dele.
    expect((await ask()).status).toBe(404);
    await owner.patch(`${base}/agents/${agent.id}`, { toolPerms: { [`connector:${conn.id}`]: "write" } });
    const asked = await ask();
    expect(asked.body).toMatchObject({ kind: "secret", approverUserId: owner.userId, secret: { target: "connector", connectorId: conn.id, name: "Anúncios" } });
    expect((await owner.post(`${base}/approvals/${asked.body.id}/decide`, { decision: "approved", secret: "tem\nquebra" })).status).toBe(400);
    expect((await owner.post(`${base}/approvals/${asked.body.id}/decide`, { decision: "approved", secret: "token-novo" })).status).toBe(200);
    const next = await runningJob(owner, ws.id, agent.id, "veja as campanhas de novo", runner);
    const text = JSON.stringify(next.assignment);
    expect(text).toContain("Bearer token-novo");
    expect(text).not.toContain("token-velho");
  });

  it("funções puras: um único segredo, formato Bearer preservado", () => {
    expect(singleSecretSlot({ headers: { Authorization: "Bearer a" } })).toEqual({ group: "headers", key: "Authorization" });
    expect(singleSecretSlot({ headers: { A: "1" }, env: { B: "2" } })).toBeNull();
    expect(singleSecretSlot({})).toBeNull();
    expect(replaceSecret({ headers: { Authorization: "Bearer a" } }, { group: "headers", key: "Authorization" }, " Bearer b ")).toEqual({ headers: { Authorization: "Bearer b" } });
    expect(replaceSecret({ env: { KEY: "a" } }, { group: "env", key: "KEY" }, "b")).toEqual({ env: { KEY: "b" } });
  });
});
