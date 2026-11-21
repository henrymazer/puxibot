import { describe, expect, it } from "vitest";
import { describeCron, describeSchedule, nextRun, nextRuns, parseCron, toCron, validateCron, type Schedule } from "./cron";

describe("toCron e parseCron", () => {
  const cases: [Schedule, string][] = [
    [{ kind: "daily", hour: 9, minute: 0 }, "0 9 * * *"],
    [{ kind: "weekdays", hour: 18, minute: 30 }, "30 18 * * 1-5"],
    [{ kind: "weekly", weekday: 1, hour: 9, minute: 4 }, "4 9 * * 1"],
    [{ kind: "interval", every: 15, unit: "minutes" }, "*/15 * * * *"],
    [{ kind: "interval", every: 2, unit: "hours" }, "0 */2 * * *"],
    [{ kind: "interval", every: 1, unit: "hours" }, "0 * * * *"],
    [{ kind: "interval", every: 1, unit: "minutes" }, "* * * * *"],
  ];
  it.each(cases)("%j <-> %s", (schedule, cron) => {
    expect(toCron(schedule)).toBe(cron);
    expect(parseCron(cron)).toEqual(schedule);
  });

  it("aceita variações comuns", () => {
    expect(parseCron("  0  9 * *   MON-FRI ")).toEqual({ kind: "weekdays", hour: 9, minute: 0 });
    expect(parseCron("0 9 * * 7")).toEqual({ kind: "weekly", weekday: 0, hour: 9, minute: 0 });
    expect(parseCron("0 9 * * fri")).toEqual({ kind: "weekly", weekday: 5, hour: 9, minute: 0 });
    expect(parseCron("0/10 * * * *")).toEqual({ kind: "interval", every: 10, unit: "minutes" });
  });

  it("o resto vira personalizado", () => {
    expect(parseCron("0 9 1 * *")).toEqual({ kind: "custom", cron: "0 9 1 * *" });
    expect(parseCron("0 9,18 * * *").kind).toBe("custom");
    expect(parseCron("bobagem").kind).toBe("custom");
    expect(toCron({ kind: "custom", cron: " 5  4 * * 0 " })).toBe("5 4 * * 0");
  });
});

describe("descrição em português", () => {
  it("descreve cada opção", () => {
    expect(describeCron("0 9 * * *")).toBe("Todo dia às 09:00");
    expect(describeCron("30 18 * * 1-5")).toBe("Dias úteis às 18:30");
    expect(describeCron("4 9 * * 1")).toBe("Toda segunda às 09:04");
    expect(describeCron("0 10 * * 6")).toBe("Todo sábado às 10:00");
    expect(describeCron("*/15 * * * *")).toBe("A cada 15 minutos");
    expect(describeCron("0 * * * *")).toBe("A cada hora");
    expect(describeSchedule({ kind: "custom", cron: "0 9 1 * *" })).toBe("Personalizado (0 9 1 * *)");
  });
});

describe("validateCron", () => {
  it("aceita expressões válidas e explica as inválidas", () => {
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("*/5 8-18 1,15 * mon,wed")).toBeNull();
    expect(validateCron("0 9 * *")).toMatch(/5 campos/);
    expect(validateCron("61 9 * * *")).toMatch(/minuto/);
    expect(validateCron("0 25 * * *")).toMatch(/hora/);
    expect(validateCron("0 9 * * x")).toMatch(/dia da semana/);
  });
});

describe("nextRuns", () => {
  // 2026-11-20 é uma sexta-feira.
  const fri0830 = new Date(2026, 10, 20, 8, 30).getTime();
  it("calcula no horário local", () => {
    expect(nextRun("0 9 * * *", fri0830)).toBe(new Date(2026, 10, 20, 9, 0).getTime());
    expect(nextRun("0 9 * * 1-5", new Date(2026, 10, 20, 9, 0).getTime())).toBe(new Date(2026, 10, 23, 9, 0).getTime());
    expect(nextRuns("*/15 * * * *", fri0830, 3)).toEqual([8 * 60 + 45, 9 * 60, 9 * 60 + 15].map((m) => new Date(2026, 10, 20, 0, m).getTime()));
  });
  it("respeita o fuso pedido", () => {
    const utcMidnight = Date.UTC(2026, 10, 20, 0, 0);
    // 09:00 em São Paulo (UTC-3) = 12:00 UTC
    expect(nextRun("0 9 * * *", utcMidnight, "America/Sao_Paulo")).toBe(Date.UTC(2026, 10, 20, 12, 0));
    expect(nextRun("0 9 * * *", utcMidnight, "UTC")).toBe(Date.UTC(2026, 10, 20, 9, 0));
  });
  it("dia do mês e dia da semana restritos valem como OU", () => {
    const runs = nextRuns("0 9 1 * 1", new Date(2026, 10, 20).getTime(), 2);
    expect(runs).toEqual([new Date(2026, 10, 23, 9).getTime(), new Date(2026, 10, 30, 9).getTime()]);
  });
  it("expressão inválida não tem próximas execuções", () => {
    expect(nextRuns("x", 0)).toEqual([]);
  });
});
