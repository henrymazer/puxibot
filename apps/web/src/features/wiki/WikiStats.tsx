import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, MessageSquareText } from "lucide-react";
import type { WikiPageDTO, WikiStatsDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { actorName } from "../../lib/actors";
import { formatNumber, formatRelative } from "../../lib/format";
import { paths } from "../../lib/paths";
import { Badge, Card, ErrorState, LoadingState } from "../../components/ui";
import { toast } from "../../components/toast";
import { ActorAvatar } from "./shared";

/** Trecho sem marcações de markdown, para leitura rápida. */
export function plainExcerpt(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_a, t: string, l?: string) => l ?? t)
    .replace(/[*_`>#]+/g, "")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/, "")
    .trim();
}

export function WikiStats({ ws, page }: { ws: string; page: WikiPageDTO }) {
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const [stats, setStats] = useState<WikiStatsDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = () => {
    setError(null);
    api
      .getWikiStats(ws, page.id)
      .then(setStats)
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [ws, page.id]);

  const openMessage = async (id: string) => {
    try {
      const m = await api.getMessage(ws, id);
      navigate(m.threadRootId ? paths.thread(ws, m.channelId, m.threadRootId) : `${paths.channel(ws, m.channelId)}?msg=${encodeURIComponent(m.id)}`);
    } catch (err) {
      toast.error(err);
    }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!stats) return <LoadingState label="Carregando as estatísticas…" />;
  const agentReads = stats.readers.filter((r) => r.reader.type === "agent").reduce((n, r) => n + r.count, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-3 md:p-4">
          <div className="text-xs text-muted">Consultas nos últimos 7 dias</div>
          <div className="text-2xl font-semibold">{formatNumber(stats.readsThisWeek)}</div>
        </Card>
        <Card className="p-3 md:p-4">
          <div className="text-xs text-muted">Feitas por agentes</div>
          <div className="text-2xl font-semibold">{formatNumber(agentReads)}</div>
        </Card>
        <Card className="p-3 md:p-4">
          <div className="text-xs text-muted">Citada em</div>
          <div className="text-2xl font-semibold">
            {stats.mentionedIn.length} {stats.mentionedIn.length === 1 ? "lugar" : "lugares"}
          </div>
        </Card>
      </div>

      <Card>
        <h3 className="mb-3 text-sm font-semibold">Quem usa esta página</h3>
        {stats.readers.length === 0 ? (
          <p className="text-sm text-muted">Ninguém abriu esta página nos últimos 7 dias.</p>
        ) : (
          <ul className="divide-y divide-line">
            {stats.readers.map((r) => (
              <li key={`${r.reader.type}:${r.reader.id}`} className="flex items-center gap-3 py-2">
                <ActorAvatar actor={r.reader} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{actorName({ members, agents }, r.reader)}</span>
                    {r.reader.type === "agent" && <Badge tone="agent">agente</Badge>}
                  </span>
                  <span className="block text-xs text-subtle">Última vez {formatRelative(r.lastAt)}</span>
                </span>
                <span className="text-sm tabular-nums text-muted">
                  {r.count} {r.count === 1 ? "vez" : "vezes"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h3 className="mb-3 text-sm font-semibold">Onde foi mencionada</h3>
        {stats.mentionedIn.length === 0 ? (
          <p className="text-sm text-muted">
            Nenhuma página ou mensagem cita esta página com <code className="font-mono text-xs">[[{page.title}]]</code>.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {stats.mentionedIn.map((m) => (
              <li key={`${m.kind}:${m.id}`}>
                <button
                  type="button"
                  onClick={() => (m.kind === "page" ? navigate(paths.wiki(ws, m.id)) : void openMessage(m.id))}
                  className="flex w-full items-start gap-2.5 rounded-md border border-line px-3 py-2 text-left hover:border-line-strong max-md:min-h-12"
                >
                  {m.kind === "page" ? <FileText className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {m.kind === "page" ? m.title : `Mensagem em ${m.title}`}
                    </span>
                    {m.excerpt && <span className="line-clamp-2 block text-xs text-muted">{plainExcerpt(m.excerpt)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
