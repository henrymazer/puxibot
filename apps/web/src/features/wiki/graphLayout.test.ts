import { describe, expect, it } from "vitest";
import { degrees, layoutGraph } from "./graphLayout";

const box = { width: 800, height: 560, padding: 40 };
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("layoutGraph", () => {
  it("lida com grafo vazio e com um nó só", () => {
    expect(layoutGraph({ nodes: [], edges: [] }, box)).toEqual({});
    expect(layoutGraph({ nodes: [{ id: "a" }], edges: [] }, box)).toEqual({ a: { x: 400, y: 280 } });
  });

  it("é determinístico e fica dentro da área com margem", () => {
    const g = { nodes: "abcdefgh".split("").map((id) => ({ id })), edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "x", to: "a" }] };
    const p1 = layoutGraph(g, box);
    const p2 = layoutGraph(g, box);
    expect(p1).toEqual(p2);
    for (const p of Object.values(p1)) {
      expect(p.x).toBeGreaterThanOrEqual(40);
      expect(p.x).toBeLessThanOrEqual(760);
      expect(p.y).toBeGreaterThanOrEqual(40);
      expect(p.y).toBeLessThanOrEqual(520);
    }
  });

  it("aproxima páginas ligadas e não sobrepõe nós", () => {
    const g = {
      nodes: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
    };
    const p = layoutGraph(g, box);
    const linked = (dist(p.a!, p.b!) + dist(p.b!, p.c!) + dist(p.c!, p.a!)) / 3;
    const loose = (dist(p.d!, p.e!) + dist(p.e!, p.f!) + dist(p.f!, p.d!)) / 3;
    expect(linked).toBeLessThan(loose);
    const ids = Object.keys(p);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(dist(p[ids[i]!]!, p[ids[j]!]!)).toBeGreaterThan(20);
  });
});

describe("degrees", () => {
  it("conta ligações de entrada e saída", () => {
    expect(degrees([{ from: "a", to: "b" }, { from: "c", to: "b" }])).toEqual({ a: 1, b: 2, c: 1 });
  });
});
