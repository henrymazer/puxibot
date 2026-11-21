/**
 * Posições do grafo da wiki: força dirigida simples (Fruchterman-Reingold), determinística
 * (começa num círculo, sem aleatoriedade). Testado em graphLayout.test.ts.
 */
export interface GraphInput {
  nodes: { id: string }[];
  edges: { from: string; to: string }[];
}
export interface Point {
  x: number;
  y: number;
}

export function layoutGraph(
  { nodes, edges }: GraphInput,
  opts: { width: number; height: number; padding?: number; iterations?: number },
): Record<string, Point> {
  const { width, height, padding = 40, iterations = 220 } = opts;
  const n = nodes.length;
  const out: Record<string, Point> = {};
  if (n === 0) return out;
  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) {
    out[nodes[0]!.id] = { x: cx, y: cy };
    return out;
  }
  const ids = nodes.map((x) => x.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const r0 = Math.min(width, height) / 2 - padding;
  const pos = ids.map((_, i) => ({ x: cx + r0 * Math.cos((2 * Math.PI * i) / n), y: cy + r0 * Math.sin((2 * Math.PI * i) / n) }));
  const links = edges
    .map((e) => [index.get(e.from), index.get(e.to)] as const)
    .filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]);
  const area = (width - 2 * padding) * (height - 2 * padding);
  const k = Math.sqrt(area / n) * 0.75;
  let temp = Math.min(width, height) / 8;
  const cool = temp / (iterations + 1);
  for (let it = 0; it < iterations; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) {
          dx = 0.01 * (i - j);
          dy = 0.01;
          d = Math.hypot(dx, dy);
        }
        const f = (k * k) / d;
        disp[i]!.x += (dx / d) * f;
        disp[i]!.y += (dy / d) * f;
        disp[j]!.x -= (dx / d) * f;
        disp[j]!.y -= (dy / d) * f;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[a]!.x - pos[b]!.x;
      const dy = pos[a]!.y - pos[b]!.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / k;
      disp[a]!.x -= (dx / d) * f;
      disp[a]!.y -= (dy / d) * f;
      disp[b]!.x += (dx / d) * f;
      disp[b]!.y += (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      // Leve atração ao centro, para nós soltos não irem para a borda.
      disp[i]!.x += (cx - pos[i]!.x) * 0.02 * k / 10;
      disp[i]!.y += (cy - pos[i]!.y) * 0.02 * k / 10;
      const d = Math.max(0.01, Math.hypot(disp[i]!.x, disp[i]!.y));
      const step = Math.min(d, temp);
      pos[i]!.x = Math.min(width - padding, Math.max(padding, pos[i]!.x + (disp[i]!.x / d) * step));
      pos[i]!.y = Math.min(height - padding, Math.max(padding, pos[i]!.y + (disp[i]!.y / d) * step));
    }
    temp = Math.max(0.5, temp - cool);
  }
  ids.forEach((id, i) => (out[id] = { x: Math.round(pos[i]!.x), y: Math.round(pos[i]!.y) }));
  return out;
}

/** Quantas ligações cada página tem (entrando e saindo). */
export function degrees(edges: { from: string; to: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) {
    out[e.from] = (out[e.from] ?? 0) + 1;
    out[e.to] = (out[e.to] ?? 0) + 1;
  }
  return out;
}
