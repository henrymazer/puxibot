import { describe, expect, it } from "vitest";
import { cronProblem, nextCronRun, parseCron, zonedToUtc } from "../src/lib/cron";

const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
const at = (s: string) => Date.parse(s);

describe("cron de 5 campos com fuso", () => {
  it("0 9 * * * em America/Sao_Paulo (UTC-3) cai às 12:00Z, e vira o dia depois das 9h locais", () => {
    expect(iso(nextCronRun("0 9 * * *", "America/Sao_Paulo", at("2026-11-21T10:00:00Z")))).toBe("2026-11-21T12:00:00.000Z");
    // 09:00 local já passou (12:30Z = 09:30 local): próximo é amanhã.
    expect(iso(nextCronRun("0 9 * * *", "America/Sao_Paulo", at("2026-11-21T12:30:00Z")))).toBe("2026-11-22T12:00:00.000Z");
    // Exatamente no horário: estritamente depois.
    expect(iso(nextCronRun("0 9 * * *", "America/Sao_Paulo", at("2026-11-21T12:00:00Z")))).toBe("2026-11-22T12:00:00.000Z");
  });

  it("virada de dia por causa do fuso: 23:30 em São Paulo é 02:30Z do dia seguinte", () => {
    expect(iso(nextCronRun("30 23 * * *", "America/Sao_Paulo", at("2026-11-21T20:00:00Z")))).toBe("2026-11-22T02:30:00.000Z");
    // Às 01:00Z do dia 22 ainda é 22:00 do dia 21 em SP.
    expect(iso(nextCronRun("0 0 * * *", "America/Sao_Paulo", at("2026-11-22T01:00:00Z")))).toBe("2026-11-22T03:00:00.000Z");
    // Fim de mês e de ano.
    expect(iso(nextCronRun("0 0 1 * *", "UTC", at("2026-12-31T23:59:00Z")))).toBe("2027-01-01T00:00:00.000Z");
  });

  it("*/15 * * * * dispara a cada 15 minutos", () => {
    let t = at("2026-11-21T10:07:30Z");
    const got: string[] = [];
    for (let i = 0; i < 5; i++) {
      t = nextCronRun("*/15 * * * *", "America/Sao_Paulo", t)!;
      got.push(iso(t)!);
    }
    expect(got).toEqual([
      "2026-11-21T10:15:00.000Z",
      "2026-11-21T10:30:00.000Z",
      "2026-11-21T10:45:00.000Z",
      "2026-11-21T11:00:00.000Z",
      "2026-11-21T11:15:00.000Z",
    ]);
  });

  it("0 9 * * 1-5 pula o fim de semana", () => {
    // 2026-11-20 é sexta; depois das 9h de sexta, o próximo é segunda 23/11.
    expect(iso(nextCronRun("0 9 * * 1-5", "America/Sao_Paulo", at("2026-11-20T13:00:00Z")))).toBe("2026-11-23T12:00:00.000Z");
    expect(iso(nextCronRun("0 9 * * mon-fri", "America/Sao_Paulo", at("2026-11-21T00:00:00Z")))).toBe("2026-11-23T12:00:00.000Z");
    // Domingo como 0 e como 7.
    expect(nextCronRun("0 9 * * 0", "UTC", at("2026-11-21T00:00:00Z"))).toBe(nextCronRun("0 9 * * 7", "UTC", at("2026-11-21T00:00:00Z")));
  });

  it("horário de verão (America/New_York): o horário que não existe roda depois do pulo; o repetido roda uma vez", () => {
    // 2026-03-08: 02:00 EST vira 03:00 EDT. 02:30 não existe -> 03:30 EDT = 07:30Z.
    expect(iso(nextCronRun("30 2 * * *", "America/New_York", at("2026-03-08T05:00:00Z")))).toBe("2026-03-08T07:30:00.000Z");
    // No dia seguinte volta ao normal: 02:30 EDT = 06:30Z.
    expect(iso(nextCronRun("30 2 * * *", "America/New_York", at("2026-03-08T08:00:00Z")))).toBe("2026-03-09T06:30:00.000Z");
    // 9h local antes e depois da mudança: 14:00Z (EST) e 13:00Z (EDT).
    expect(iso(nextCronRun("0 9 * * *", "America/New_York", at("2026-03-07T15:00:00Z")))).toBe("2026-03-08T13:00:00.000Z");
    // 2026-11-01: 02:00 EDT volta para 01:00 EST. 01:30 existe duas vezes: só a primeira (05:30Z).
    const first = nextCronRun("30 1 * * *", "America/New_York", at("2026-11-01T04:00:00Z"));
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(nextCronRun("30 1 * * *", "America/New_York", first!))).toBe("2026-11-02T06:30:00.000Z");
    expect(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York")).toBe(first);
  });

  it("dia do mês e dia da semana restritos: basta um casar; listas e passos com intervalo", () => {
    // Dia 1 ou sexta-feira.
    expect(iso(nextCronRun("0 12 1 * 5", "UTC", at("2026-11-21T00:00:00Z")))).toBe("2026-11-27T12:00:00.000Z");
    expect(parseCron("0,30 8-18/2 * * *").hours).toEqual([8, 10, 12, 14, 16, 18]);
    expect(parseCron("0,30 8-18/2 * * *").minutes).toEqual([0, 30]);
    // 29/02 só em ano bissexto.
    expect(iso(nextCronRun("0 0 29 2 *", "UTC", at("2026-03-01T00:00:00Z")))).toBe("2028-02-29T00:00:00.000Z");
  });

  it("expressões inválidas e fusos desconhecidos dão mensagem em português", () => {
    expect(cronProblem("0 9 * *", "UTC")).toMatch(/5 campos/);
    expect(cronProblem("61 9 * * *", "UTC")).toMatch(/fora do intervalo/);
    expect(cronProblem("0 9 * * *", "Marte/Olympus")).toMatch(/Fuso horário desconhecido/);
    expect(cronProblem("0 0 31 2 *", "UTC")).toMatch(/nunca/);
    expect(cronProblem("*/15 * * * *", "America/Sao_Paulo")).toBeNull();
  });
});
