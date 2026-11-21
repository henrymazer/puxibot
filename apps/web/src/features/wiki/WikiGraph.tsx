import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Network } from "lucide-react";
import type { WikiGraphDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { paths } from "../../lib/paths";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui";
import { degrees, layoutGraph } from "./graphLayout";

/** Paisagem no computador, retrato no celular (para os nomes ficarem legíveis). */
function useDims() {
  const q = "(max-width: 639px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow ? { W: 400, H: 620, pad: 50 } : { W: 800, H: 540, pad: 60 };
}

/** Visão em grafo: cada página é um ponto; linhas são links [[Título]] entre elas. */
export function WikiGraph({ ws }: { ws: string }) {
  const version = useWorkspace((s) => s.wikiVersion);
  const [graph, setGraph] = useState<WikiGraphDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const navigate = useNavigate();
  const { W, H, pad } = useDims();

  const load = () => {
    setError(null);
    api
      .getWikiGraph(ws)
      .then(setGraph)
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [ws, version]);

  const pos = useMemo(() => (graph ? layoutGraph(graph, { width: W, height: H, padding: pad }) : {}), [graph, W, H, pad]);
  const deg = useMemo(() => (graph ? degrees(graph.edges) : {}), [graph]);
  const titles = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n.title])), [graph]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!graph) return <LoadingState label="Montando o grafo…" />;
  if (graph.nodes.length === 0)
    return (
      <EmptyState icon={<Network className="size-5" />} title="Nenhuma página ainda" className="mt-10">
        Crie páginas e ligue umas às outras com [[Título]].
      </EmptyState>
    );

  const near = (id: string) => !hover || id === hover || graph.edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id));
  const open = (id: string) => navigate(paths.wiki(ws, id));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 md:p-6">
      <div>
        <h2 className="text-lg font-semibold">Grafo da wiki</h2>
        <p className="text-sm text-muted">
          {graph.nodes.length} páginas e {graph.edges.length} ligações. Páginas que se citam com [[Título]] ficam perto. Toque numa página para abrir.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="group" aria-label="Grafo de páginas da wiki">
          <defs>
            <marker id="tb-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--tb-border-strong)" />
            </marker>
          </defs>
          {graph.edges.map((e, i) => {
            const a = pos[e.from];
            const b = pos[e.to];
            if (!a || !b) return null;
            const rb = 8 + Math.min(deg[e.to] ?? 0, 6) * 2;
            const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
            const ex = b.x - ((b.x - a.x) / len) * (rb + 3);
            const ey = b.y - ((b.y - a.y) / len) * (rb + 3);
            const lit = hover && (e.from === hover || e.to === hover);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={ex}
                y2={ey}
                stroke={lit ? "var(--tb-primary)" : "var(--tb-border-strong)"}
                strokeWidth={lit ? 2.5 : 1.5}
                opacity={hover && !lit ? 0.25 : 1}
                markerEnd="url(#tb-arrow)"
              />
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            const r = 8 + Math.min(deg[n.id] ?? 0, 6) * 2;
            const dim = !near(n.id);
            const labelBelow = p.y < H - 50;
            const label = n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title;
            const half = (label.length * 7.4) / 2 + 6;
            const lx = Math.min(W - half, Math.max(half, p.x));
            return (
              <g
                key={n.id}
                role="link"
                tabIndex={0}
                aria-label={`${n.title}, ${deg[n.id] ?? 0} ligações`}
                className="tb-wiki-graph-node cursor-pointer"
                opacity={dim ? 0.3 : 1}
                onClick={() => open(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(n.id);
                  }
                }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
              >
                <circle cx={p.x} cy={p.y} r={r + 12} fill="transparent" />
                <circle cx={p.x} cy={p.y} r={r} fill={hover === n.id ? "var(--tb-primary)" : "var(--tb-primary-soft)"} stroke="var(--tb-primary)" strokeWidth={2} />
                <text
                  x={lx}
                  y={labelBelow ? p.y + r + 16 : p.y - r - 8}
                  textAnchor="middle"
                  fontSize={14}
                  fontWeight={hover === n.id ? 650 : 500}
                  fill="var(--tb-text)"
                  stroke="var(--tb-surface)"
                  strokeWidth={4}
                  paintOrder="stroke"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <details className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">Ver as ligações em lista</summary>
        <ul className="mt-2 space-y-1.5">
          {graph.nodes.map((n) => {
            const out = graph.edges.filter((e) => e.from === n.id).map((e) => titles.get(e.to)).filter(Boolean);
            return (
              <li key={n.id}>
                <button type="button" className="font-medium text-primary-text underline underline-offset-2" onClick={() => open(n.id)}>
                  {n.title}
                </button>
                <span className="text-muted">{out.length ? ` → ${out.join(", ")}` : " (não cita outras páginas)"}</span>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
