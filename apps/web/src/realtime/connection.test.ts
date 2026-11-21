import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEvent } from "@puxibot/shared";
import { backoffDelay, RealtimeConnection, type SocketLike } from "./connection";

class MockSocket implements SocketLike {
  static all: MockSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    MockSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("RealtimeConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it("entrega eventos, reconecta com espera e avisa para ressincronizar", () => {
    const events: ClientEvent[] = [];
    const onReconnect = vi.fn();
    const statuses: string[] = [];
    const c = new RealtimeConnection({ url: "ws://x", createSocket: () => new MockSocket(), onEvent: (e) => events.push(e), onReconnect, onStatus: (s) => statuses.push(s) });
    c.start();
    const s1 = MockSocket.all[0]!;
    s1.open();
    s1.onmessage?.({ data: JSON.stringify({ type: "hello", userId: "u1", serverTime: 1 }) });
    s1.onmessage?.({ data: "lixo" });
    expect(events).toHaveLength(1);
    expect(onReconnect).not.toHaveBeenCalled();

    s1.close();
    expect(statuses.at(-1)).toBe("offline");
    vi.advanceTimersByTime(2000);
    const s2 = MockSocket.all[1]!;
    expect(s2).toBeDefined();
    s2.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(c.send({ type: "typing", channelId: "c1" })).toBe(true);
    expect(JSON.parse(s2.sent[0]!)).toEqual({ type: "typing", channelId: "c1" });
    c.stop();
  });

  it("fechamento 4008 (conexões demais) não reconecta sozinho; reconnect() volta", () => {
    const statuses: string[] = [];
    const c = new RealtimeConnection({ url: "ws://x", createSocket: () => new MockSocket(), onEvent: () => undefined, onStatus: (s) => statuses.push(s) });
    c.start();
    MockSocket.all[0]!.open();
    MockSocket.all[0]!.close(4008);
    expect(statuses.at(-1)).toBe("too_many");
    vi.advanceTimersByTime(120_000);
    expect(MockSocket.all).toHaveLength(1);
    c.reconnect();
    expect(MockSocket.all).toHaveLength(2);
    MockSocket.all[1]!.open();
    expect(statuses.at(-1)).toBe("online");
    c.stop();
  });

  it("espera cresce até 30 s", () => {
    const r = () => 0.5;
    expect(backoffDelay(0, r)).toBe(1000);
    expect(backoffDelay(1, r)).toBe(2000);
    expect(backoffDelay(10, r)).toBe(30000);
  });
});
