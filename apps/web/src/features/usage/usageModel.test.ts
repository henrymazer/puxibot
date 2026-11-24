import { describe, expect, it } from "vitest";
import type { UsageEntryDTO } from "@puxibot/shared";
import {
  actionCountLabel,
  actionKindLabel,
  actionStatus,
  groupByDay,
  jobStatus,
  lastMonths,
  mergeEntries,
  originLabel,
  periodOf,
} from "./usageModel";

const entry = (over: Partial<UsageEntryDTO>) => ({ origin: "user", mode: null, ...over }) as UsageEntryDTO;
/** Horário local, para o teste não depender do fuso da máquina. */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("originLabel", () => {
  it("preparação automática ganha de qualquer origem", () => {
    expect(originLabel(entry({ mode: "prepare", origin: "routine" }))).toBe("Preparação automática");
    expect(originLabel(entry({ mode: "prepare", origin: "user" }), { name: "Ana" })).toBe("Preparação automática");
  });

  it("rotina, outro agente e sistema", () => {
    expect(originLabel(entry({ origin: "routine" }))).toBe("Rotina");
    expect(originLabel(entry({ origin: "agent" }))).toBe("Outro agente");
    expect(originLabel(entry({ origin: "system" }))).toBe("Sistema");
  });

  it("pedido de pessoa usa o nome; sem nome, fica genérico", () => {
    expect(originLabel(entry({ origin: "user" }), { name: "Débora Lima" })).toBe("Pedido de Débora Lima");
    expect(originLabel(entry({ origin: "user" }))).toBe("Pedido de uma pessoa");
    expect(originLabel(entry({ origin: "user" }), { name: null })).toBe("Pedido de uma pessoa");
  });

  it("pedido de quem está olhando", () => {
    expect(originLabel(entry({ origin: "user" }), { name: "Débora", isMe: true })).toBe("Pedido seu");
  });
});

describe("actionStatus", () => {
  it("negada", () => {
    expect(actionStatus({ decision: "denied", status: "blocked" })).toEqual({ label: "negada", tone: "danger" });
  });
  it("esperando aprovação", () => {
    expect(actionStatus({ decision: "asked", status: "pending" })).toEqual({ label: "esperando aprovação", tone: "warning" });
  });
  it("erro", () => {
    expect(actionStatus({ decision: "allowed", status: "error" })).toEqual({ label: "erro", tone: "danger" });
    expect(actionStatus({ decision: "asked", status: "error" })).toEqual({ label: "erro", tone: "danger" });
  });
  it("pediu aprovação e foi barrada: não diz que foi feita", () => {
    expect(actionStatus({ decision: "asked", status: "blocked" })).toEqual({ label: "não feita", tone: "danger" });
  });
  it("feita", () => {
    expect(actionStatus({ decision: "allowed", status: "ok" })).toEqual({ label: "feita", tone: "success" });
    expect(actionStatus({ decision: "asked", status: "ok" })).toEqual({ label: "feita", tone: "success" });
  });
});

describe("rótulos pequenos", () => {
  it("tipo da ação", () => {
    expect(actionKindLabel("read")).toBe("leitura");
    expect(actionKindLabel("write")).toBe("ação");
  });
  it("contagem de ações", () => {
    expect(actionCountLabel(0)).toBe("sem ações em serviços externos");
    expect(actionCountLabel(1)).toBe("1 ação");
    expect(actionCountLabel(4)).toBe("4 ações");
  });
  it("status do trabalho, com reserva para status desconhecido", () => {
    expect(jobStatus("done")).toEqual({ label: "Concluído", tone: "success" });
    expect(jobStatus("novo" as never)).toEqual({ label: "novo", tone: "neutral" });
  });
});

describe("groupByDay", () => {
  it("agrupa por dia local, mais novo primeiro", () => {
    const items = [
      { id: "a", createdAt: at(2026, 11, 22, 9) },
      { id: "b", createdAt: at(2026, 11, 23, 8) },
      { id: "c", createdAt: at(2026, 11, 23, 23, 59) },
      { id: "d", createdAt: at(2026, 11, 22, 0, 0) },
    ];
    const groups = groupByDay(items);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ["c", "b"],
      ["a", "d"],
    ]);
    expect(groups[0]!.day).toBe(at(2026, 11, 23, 0));
    expect(groups[1]!.day).toBe(at(2026, 11, 22, 0));
  });

  it("lista vazia e não altera a entrada", () => {
    expect(groupByDay([])).toEqual([]);
    const items = [{ createdAt: 1 }, { createdAt: 2 }];
    groupByDay(items);
    expect(items.map((i) => i.createdAt)).toEqual([1, 2]);
  });
});

describe("mergeEntries", () => {
  it("não repete o mesmo trabalho ao carregar mais", () => {
    const a = entry({ jobId: "j1" });
    const b = entry({ jobId: "j2" });
    const c = entry({ jobId: "j3" });
    expect(mergeEntries([a, b], [b, c]).map((e) => e.jobId)).toEqual(["j1", "j2", "j3"]);
  });
});

describe("meses", () => {
  it("periodOf", () => {
    expect(periodOf(at(2026, 11, 23))).toBe("2026-11");
    expect(periodOf(at(2026, 1, 1, 0))).toBe("2026-01");
  });

  it("últimos 12 meses, começando pelo atual", () => {
    const months = lastMonths(at(2026, 11, 23));
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ value: "2026-11", label: "novembro de 2026" });
    expect(months[1]).toEqual({ value: "2026-10", label: "outubro de 2026" });
    expect(months[11]).toEqual({ value: "2025-12", label: "dezembro de 2025" });
  });

  it("vira o ano e não pula mês no dia 31", () => {
    const months = lastMonths(at(2026, 3, 31), 4);
    expect(months.map((m) => m.value)).toEqual(["2026-03", "2026-02", "2026-01", "2025-12"]);
    expect(months[1]!.label).toBe("fevereiro de 2026");
  });
});
