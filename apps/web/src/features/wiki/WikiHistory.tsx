import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import type { WikiPageDTO, WikiRevisionDTO } from "@puxibot/shared";
import { api, ApiClientError, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { formatDateTime, formatRelative } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, LoadingState } from "../../components/ui";
import { toast } from "../../components/toast";
import { WikiMarkdown } from "./WikiMarkdown";
import { ActorAvatar, useAuthorship } from "./shared";

/** Histórico de versões: ver uma versão antiga e restaurar (vira uma versão nova). */
export function WikiHistory({ ws, page, pages, onRestored }: { ws: string; page: WikiPageDTO; pages: WikiPageDTO[]; onRestored: (p: WikiPageDTO) => void }) {
  const pageVersion = useWorkspace((s) => s.wikiPageVersions[page.id] ?? 0);
  const [items, setItems] = useState<WikiRevisionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WikiRevisionDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const authorship = useAuthorship();

  const load = () => {
    setError(null);
    api
      .listWikiRevisions(ws, page.id)
      .then((list) => setItems([...list].sort((a, b) => b.version - a.version)))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [ws, page.id, pageVersion]);

  const restore = async (r: WikiRevisionDTO) => {
    setBusy(true);
    try {
      const saved = await api.updateWikiPage(ws, page.id, { title: r.title, body: r.body, baseVersion: page.version, note: `Restaurado da versão ${r.version}` });
      toast.success(`Versão ${r.version} restaurada.`);
      setConfirm(null);
      onRestored(saved);
    } catch (err) {
      toast.error(err instanceof ApiClientError && err.status === 409 ? "A página mudou agora há pouco. Veja o histórico atualizado e tente de novo." : err);
      setConfirm(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState label="Carregando o histórico…" />;
  if (items.length === 0)
    return (
      <EmptyState icon={<History className="size-5" />} title="Sem versões guardadas">
        As próximas edições desta página aparecem aqui.
      </EmptyState>
    );

  const current = items.find((r) => r.id === selected) ?? items[0]!;
  const latest = items[0]!.version;

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <ol className="flex shrink-0 flex-col gap-1 lg:w-80" aria-label="Versões da página">
        {items.map((r) => {
          const active = r.id === current.id;
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setSelected(r.id)}
                aria-pressed={active}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left max-md:min-h-14",
                  active ? "border-primary bg-primary-soft" : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <ActorAvatar actor={r.author} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                    Versão {r.version}
                    {r.version === latest && <Badge tone="primary">atual</Badge>}
                  </span>
                  <span className="block text-xs text-muted">{authorship(r.author, r.onBehalfOfUserId)}</span>
                  <span className="block text-xs text-subtle" title={formatDateTime(r.createdAt)}>
                    {formatRelative(r.createdAt)}
                    {r.note ? ` · ${r.note}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <section className="min-w-0 flex-1 rounded-lg border border-line bg-surface p-4" aria-label={`Versão ${current.version}`}>
        <div className="mb-3 flex flex-col gap-2 border-b border-line pb-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">
              Versão {current.version}: {current.title}
            </h3>
            <p className="text-xs text-muted">
              {authorship(current.author, current.onBehalfOfUserId)} · {formatDateTime(current.createdAt)}
            </p>
          </div>
          {current.version !== latest && (
            <Button size="sm" icon={<RotateCcw className="size-4" />} onClick={() => setConfirm(current)}>
              Restaurar esta versão
            </Button>
          )}
        </div>
        {current.body.trim() ? <WikiMarkdown text={current.body} pages={pages} ws={ws} /> : <p className="text-sm text-muted">Versão sem conteúdo.</p>}
      </section>
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && void restore(confirm)}
        loading={busy}
        title={`Restaurar a versão ${confirm?.version}?`}
        body="O texto dessa versão vira uma versão nova. Nada do histórico é apagado."
        confirmLabel="Restaurar"
      />
    </div>
  );
}
