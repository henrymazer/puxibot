import { describe, expect, it } from "vitest";
import { buildTimeline, firstUnreadId, GROUP_WINDOW_MS } from "./timeline";
import { msg } from "../test/fixtures";

const day = (d: number, h = 10, m = 0) => new Date(2026, 10, d, h, m).getTime();

describe("buildTimeline", () => {
  it("agrupa mensagens seguidas do mesmo autor dentro da janela", () => {
    const items = buildTimeline(
      [
        msg({ id: "1", createdAt: day(20, 10, 0) }),
        msg({ id: "2", createdAt: day(20, 10, 2) }),
        msg({ id: "3", author: { type: "agent", id: "a1" }, createdAt: day(20, 10, 3) }),
        msg({ id: "4", author: { type: "agent", id: "a1" }, createdAt: day(20, 10, 3) + GROUP_WINDOW_MS + 1 }),
      ],
      { now: day(21) },
    );
    const msgs = items.filter((i) => i.kind === "message");
    expect(msgs.map((i) => (i.kind === "message" ? i.continuation : null))).toEqual([false, true, false, false]);
  });

  it("insere separador de dia com Hoje/Ontem", () => {
    const items = buildTimeline([msg({ id: "1", createdAt: day(19) }), msg({ id: "2", createdAt: day(20) })], { now: day(20, 18) });
    const days = items.filter((i) => i.kind === "day").map((i) => (i.kind === "day" ? i.label : ""));
    expect(days).toEqual(["Ontem", "Hoje"]);
    // mudança de dia quebra o grupo
    expect(items[3]).toMatchObject({ kind: "message", continuation: false });
  });

  it("marcador Novas quebra o grupo", () => {
    const items = buildTimeline([msg({ id: "1", createdAt: day(20) }), msg({ id: "2", createdAt: day(20, 10, 1) })], { firstUnreadId: "2", now: day(20) });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "new", "message"]);
    expect(items[3]).toMatchObject({ continuation: false });
  });

  it("mensagens de sistema nunca agrupam", () => {
    const sys = { type: "system" as const, id: null };
    const items = buildTimeline([msg({ id: "1", author: sys, createdAt: day(20) }), msg({ id: "2", author: sys, createdAt: day(20) })], { now: day(20) });
    expect(items.filter((i) => i.kind === "message").every((i) => i.kind === "message" && !i.continuation)).toBe(true);
  });
});

describe("firstUnreadId", () => {
  it("conta de trás para frente ignorando mensagens próprias", () => {
    const list = [msg({ id: "1" }), msg({ id: "2" }), msg({ id: "3", author: { type: "user", id: "me" } }), msg({ id: "4" })];
    expect(firstUnreadId(list, 2, "me")).toBe("2");
    expect(firstUnreadId(list, 0, "me")).toBeNull();
    expect(firstUnreadId(list, 10, "me")).toBe("1");
  });
});
