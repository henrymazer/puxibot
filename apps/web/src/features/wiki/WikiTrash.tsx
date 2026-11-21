import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Folder, RotateCcw, Trash2 } from "lucide-react";
import type { WikiPageDTO } from "@puxibot/shared";
import { api } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { isAdmin } from "../../lib/actors";
import { formatRelative } from "../../lib/format";
import { paths } from "../../lib/paths";
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, LoadingState, LockedNote } from "../../components/ui";
import { toast } from "../../components/toast";
import { useAuthorship, useWikiPages } from "./shared";

export function WikiTrash({ ws }: { ws: string }) {
  const { pages, error, reload } = useWikiPages(ws, true);
  const me = useWorkspace((s) => s.me);
  const admin = isAdmin(me?.role);
  const authorship = useAuthorship();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [purge, setPurge] = useState<WikiPageDTO | null>(null);

  const restore = async (p: WikiPageDTO) => {
    setBusy(p.id);
    try {
      await api.restoreWikiPage(ws, p.id);
      toast.success(`“${p.title}” voltou para a wiki.`);
      reload();
      if (!p.isFolder) navigate(paths.wiki(ws, p.id));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (p: WikiPageDTO) => {
    setBusy(p.id);
    try {
      await api.deleteWikiPage(ws, p.id, { permanent: true });
      toast.success(`“${p.title}” foi apagada de vez.`);
      setPurge(null);
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  // Mostra só o topo do que foi apagado junto (a pasta, não cada página dentro dela).
  const ids = new Set((pages ?? []).map((p) => p.id));
  const top = (pages ?? []).filter((p) => !p.parentId || !ids.has(p.parentId)).sort((a, b) => b.updatedAt - a.updatedAt);
  const inside = (id: string) => (pages ?? []).filter((p) => p.parentId === id).length;

  return (
    <div className="mx-auto w-full max-w-3xl p-3 md:p-6">
      <h2 className="text-lg font-semibold">Lixeira</h2>
      <p className="mb-4 text-sm text-muted">Páginas apagadas ficam aqui até alguém restaurar.{admin ? " Admins podem apagar de vez." : ""}</p>
      {!admin && <LockedNote>Só admins apagam de vez.</LockedNote>}
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !pages ? (
        <LoadingState />
      ) : top.length === 0 ? (
        <EmptyState icon={<Trash2 className="size-5" />} title="A lixeira está vazia" />
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
          {top.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 md:px-4">
              {p.isFolder ? <Folder className="size-4 shrink-0 text-muted" aria-hidden /> : <FileText className="size-4 shrink-0 text-muted" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.title}</div>
                <div className="text-xs text-muted">
                  Apagada por {authorship(p.updatedBy, p.onBehalfOfUserId)} {formatRelative(p.updatedAt)}
                  {p.isFolder && inside(p.id) > 0 ? ` · com ${inside(p.id)} ${inside(p.id) === 1 ? "item" : "itens"} dentro` : ""}
                </div>
              </div>
              <Button size="sm" icon={<RotateCcw className="size-4" />} onClick={() => void restore(p)} loading={busy === p.id}>
                Restaurar
              </Button>
              {admin && (
                <IconButton label={`Apagar “${p.title}” de vez`} onClick={() => setPurge(p)} className="hover:text-danger">
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!purge}
        onClose={() => setPurge(null)}
        onConfirm={() => purge && void remove(purge)}
        loading={!!purge && busy === purge.id}
        danger
        title={`Apagar “${purge?.title}” de vez?`}
        body="A página e todo o histórico de versões somem para sempre. Não dá para desfazer."
        confirmLabel="Apagar de vez"
      />
    </div>
  );
}
