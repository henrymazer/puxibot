import { describe, expect, it } from "vitest";
import { waitingForRunnerText } from "./PendingJobs";

describe("waitingForRunnerText", () => {
  it("na DM com agente de outra pessoa, diz que espera o computador de quem pediu", () => {
    const t = waitingForRunnerText({ requestedByMe: true, myRunnerOnline: false, isDm: true, agentOwnedByMe: false });
    expect(t).toMatch(/Esperando o seu computador/);
    expect(t).toMatch(/puxibot start/);
  });
  it("em canal, sem o meu computador, avisa que nenhum outro que possa atender está online", () => {
    expect(waitingForRunnerText({ requestedByMe: true, myRunnerOnline: false, isDm: false, agentOwnedByMe: false })).toMatch(/o seu não está ligado/);
  });
  it("pedido de outra pessoa: aviso genérico", () => {
    expect(waitingForRunnerText({ requestedByMe: false, myRunnerOnline: true, isDm: false, agentOwnedByMe: true })).toMatch(/^Nenhum computador/);
  });
});
