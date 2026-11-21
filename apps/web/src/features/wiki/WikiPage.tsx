import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, BookOpen, FilePlus2, FileText, Folder, FolderInput, MoreVertical, Network, Pencil, TextCursorInput, Trash2 } from "lucide-react";
import type { WikiPageDTO } from "@puxibot/shared";
import { api, ApiClientError, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { formatDateTime, formatRelative } from "../../lib/format";
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, InlineError, LoadingState, Tabs } from "../../components/ui";
import { MenuItem, Popover } from "../../components/Popover";
import { toast } from "../../components/toast";
import { PageHeader } from "../shell/PageHeader";
import { useWsId } from "../shell/hooks";
import { WikiTree } from "./WikiTree";
import { CreateDialog, EditMetaDialog } from "./WikiDialogs";
import { drafts, WikiEditor, type Draft } from "./WikiEditor";
import { WikiHistory } from "./WikiHistory";
import { WikiStats } from "./WikiStats";
import { WikiTrash } from "./WikiTrash";
import { WikiGraph } from "./WikiGraph";
import { WikiMarkdown } from "./WikiMarkdown";
import { ActorAvatar, useAuthorship, useWikiPages } from "./shared";
import { ancestors } from "./tree";

type Aba = "pagina" | "editar" | "historico" | "estatisticas";

/** Wiki: árvore à esquerda (tela cheia no celular), página, editor, histórico, estatísticas, lixeira e grafo. */
export function WikiPage() {
  const ws = useWsId();
  const { pageId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view = params.get("visao");
  const nova = params.get("nova");
  const { pages, error, reload } = useWikiPages(ws);
  const [create, setCreate] = useState<{ kind: "page" | "folder"; title?: string; parent?: string } | null>(null);

  // Link [[Página que não existe]] abre a criação já com o título.
  useEffect(() => {
    if (nova) setCreate({ kind: "page", title: nova });
  }, [nova]);

  const current = pageId ? pages?.find((p) => p.id === pageId) : undefined;
  const showContent = !!pageId || view === "lixeira" || view === "grafo";

  const closeCreate = () => {
    setCreate(null);
    if (nova)
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete("nova");
          return n;
        },
        { replace: true },
      );
  };
  const defaultParent = current ? (current.isFolder ? current.id : current.parentId ?? "") : "";

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title="Wiki"
        icon={<BookOpen className="size-5" />}
        subtitle={pages ? ((n) => `${n} ${n === 1 ? "página" : "páginas"}`)(pages.filter((p) => !p.isFolder).length) : undefined}
        className={cn(showContent && "max-md:hidden")}
      />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Páginas"
          className={cn("flex min-h-0 w-full flex-col bg-surface md:w-72 md:shrink-0 md:border-r md:border-line", showContent && "max-md:hidden")}
        >
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : (
            <WikiTree ws={ws} pages={pages} activeId={pageId} onCreate={(kind) => setCreate({ kind, parent: defaultParent })} />
          )}
        </aside>
        <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-bg", !showContent && "max-md:hidden")}>
          {view === "lixeira" ? (
            <Scrollable title="Lixeira">
              <WikiTrash ws={ws} />
            </Scrollable>
          ) : view === "grafo" ? (
            <Scrollable title="Grafo">
              <WikiGraph ws={ws} />
            </Scrollable>
          ) : pageId ? (
            !pages ? (
              <LoadingState />
            ) : (
              <PageView key={pageId} ws={ws} pageId={pageId} pages={pages} onCreateIn={(parent) => setCreate({ kind: "page", parent })} />
            )
          ) : (
            <WikiOverview ws={ws} pages={pages} onCreate={() => setCreate({ kind: "page" })} />
          )}
        </section>
      </div>
      {create && pages && (
        <CreateDialog
          ws={ws}
          pages={pages}
          initialKind={create.kind}
          initialTitle={create.title}
          initialParent={create.parent ?? ""}
          onClose={closeCreate}
          onCreated={(p) => {
            setCreate(null);
            reload();
            navigate(`${paths.wiki(ws, p.id)}${p.isFolder ? "" : "?aba=editar"}`, { replace: !!nova });
          }}
        />
      )}
    </div>
  );
}

/** Cabeçalho de "voltar" no celular para as visões sem página. */
function Scrollable({ title, children }: { title: string; children: React.ReactNode }) {
  const ws = useWsId();
  return (
    <>
      <MobileBack ws={ws} title={title} />
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
    </>
  );
}

function MobileBack({ ws, title, actions }: { ws: string; title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line bg-surface px-2 pt-[env(safe-area-inset-top)] md:hidden">
      <Link to={paths.wiki(ws)} aria-label="Voltar para a lista de páginas" className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2">
        <ArrowLeft className="size-5" />
      </Link>
      <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
      {actions}
    </div>
  );
}

function WikiOverview({ ws, pages, onCreate }: { ws: string; pages: WikiPageDTO[] | null; onCreate: () => void }) {
  const authorship = useAuthorship();
  if (!pages) return <LoadingState />;
  const recent = pages.filter((p) => !p.isFolder).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  if (recent.length === 0)
    return (
      <EmptyState icon={<BookOpen className="size-5" />} title="A wiki está vazia" className="mt-16" action={<Button variant="primary" onClick={onCreate}>Criar a primeira página</Button>}>
        Junte aqui o que o time e os agentes precisam saber: processos, clientes, decisões.
      </EmptyState>
    );
  return (
    <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl p-3 md:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-lg font-semibold">Mudou por último</h2>
          <Link to={`${paths.wiki(ws)}?visao=grafo`} className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm text-muted hover:bg-surface-2 hover:text-ink">
            <Network className="size-4" aria-hidden /> Ver grafo
          </Link>
          <Button variant="primary" size="sm" icon={<FilePlus2 className="size-4" />} onClick={onCreate}>
            Nova página
          </Button>
        </div>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {recent.map((p) => (
            <li key={p.id}>
              <Link to={paths.wiki(ws, p.id)} className="flex items-center gap-3 px-3 py-3 hover:bg-surface-2 md:px-4">
                <ActorAvatar actor={p.updatedBy} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{p.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {authorship(p.updatedBy, p.onBehalfOfUserId)} · {formatRelative(p.updatedAt)}
                  </span>
                </span>
                <span className="text-xs text-subtle">v{p.version}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PageView({ ws, pageId, pages, onCreateIn }: { ws: string; pageId: string; pages: WikiPageDTO[]; onCreateIn: (parent: string) => void }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const remoteVersion = useWorkspace((s) => s.wikiPageVersions[pageId] ?? 0);
  const authorship = useAuthorship();
  const [page, setPage] = useState<WikiPageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WikiPageDTO | null>(null);
  const [remoteNotice, setRemoteNotice] = useState<WikiPageDTO | null>(null);
  const [menu, setMenu] = useState(false);
  const [meta, setMeta] = useState<"rename" | "move" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const savedVersion = useRef<number | null>(null);
  const firstRemote = useRef(remoteVersion);

  const abaParam = params.get("aba") as Aba | null;
  const aba: Aba = abaParam && ["pagina", "editar", "historico", "estatisticas"].includes(abaParam) ? abaParam : "pagina";
  const setAba = (a: Aba) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (a === "pagina") n.delete("aba");
        else n.set("aba", a);
        return n;
      },
      { replace: a !== "editar" },
    );

  const load = (then?: (p: WikiPageDTO) => void) => {
    setError(null);
    api
      .getWikiPage(ws, pageId)
      .then((p) => {
        setPage(p);
        then?.(p);
      })
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(() => load(), [ws, pageId]);

  const editing = aba === "editar" && !!page && !page.isFolder && !page.deleted;
  const dirty = !!draft && !!page && (draft.title !== page.title || draft.body !== page.body);

  // Começa a editar: usa o rascunho guardado, se houver, senão a versão aberta.
  useEffect(() => {
    if (!editing || draft || !page) return;
    const stored = drafts.load(ws, page.id);
    if (stored && (stored.title !== page.title || stored.body !== page.body)) {
      setDraft({ title: stored.title, body: stored.body, baseVersion: stored.baseVersion });
      setRecovered(true);
    } else setDraft({ title: page.title, body: page.body, baseVersion: page.version });
  }, [editing, page, draft, ws]);

  // Outra pessoa ou agente mudou a página (evento `wiki.changed`).
  useEffect(() => {
    if (remoteVersion === firstRemote.current) return;
    firstRemote.current = remoteVersion;
    api
      .getWikiPage(ws, pageId)
      .then((latest) => {
        if (latest.version === savedVersion.current) return; // eco do próprio salvamento
        if (editing && draft) {
          if (latest.version !== draft.baseVersion) setRemoteNotice(latest);
        } else setPage(latest);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteVersion]);

  const updateDraft = (d: Draft) => {
    setDraft(d);
    drafts.save(ws, pageId, d);
  };

  const finishEditing = (saved?: WikiPageDTO) => {
    drafts.clear(ws, pageId);
    setDraft(null);
    setRecovered(false);
    setConflict(null);
    setRemoteNotice(null);
    setSaveError(null);
    if (saved) setPage(saved);
    setAba("pagina");
  };

  const save = async (note: string, baseVersion = draft?.baseVersion) => {
    if (!draft || !page) return;
    if (!draft.title.trim()) {
      setSaveError("O título não pode ficar vazio.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.updateWikiPage(ws, page.id, { title: draft.title.trim(), body: draft.body, baseVersion, note: note.trim() || undefined });
      savedVersion.current = saved.version;
      toast.success("Página salva.");
      finishEditing(saved);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        try {
          setConflict(await api.getWikiPage(ws, page.id));
        } catch (e) {
          setSaveError(errorMessage(e));
        }
      } else setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!page) return;
    try {
      await api.deleteWikiPage(ws, page.id);
      drafts.clear(ws, page.id);
      toast.success(`“${page.title}” foi para a lixeira.`);
      navigate(page.parentId ? paths.wiki(ws, page.parentId) : paths.wiki(ws));
    } catch (err) {
      toast.error(err);
    }
  };

  const crumbs = useMemo(() => ancestors(pages, pageId), [pages, pageId]);
  const children = useMemo(() => pages.filter((p) => p.parentId === pageId && !p.deleted).sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.title.localeCompare(b.title, "pt-BR")), [pages, pageId]);

  if (error) {
    return (
      <>
        <MobileBack ws={ws} title="Wiki" />
        <ErrorState message={error} onRetry={() => load()} />
      </>
    );
  }
  if (!page) return <LoadingState />;

  const tabs: { id: Aba; label: string }[] = page.isFolder
    ? [{ id: "pagina", label: "Conteúdo" }]
    : [
        { id: "pagina", label: "Página" },
        { id: "historico", label: "Histórico" },
        { id: "estatisticas", label: "Estatísticas" },
      ];

  const actions = (
    <>
      {!page.isFolder && !editing && !page.deleted && (
        <Button size="sm" variant="primary" icon={<Pencil className="size-4" />} onClick={() => setAba("editar")}>
          Editar
        </Button>
      )}
      <IconButton ref={menuAnchor} label="Mais opções da página" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
        <MoreVertical className="size-4.5" />
      </IconButton>
    </>
  );

  return (
    <>
      <MobileBack ws={ws} title="Wiki" actions={actions} />
      <div className="shrink-0 border-b border-line bg-surface px-3 pt-3 md:px-5">
        {crumbs.length > 0 && (
          <nav aria-label="Caminho" className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted">
            {crumbs.map((c) => (
              <span key={c.id} className="flex items-center gap-1">
                <Link to={paths.wiki(ws, c.id)} className="hover:text-ink hover:underline">
                  {c.title}
                </Link>
                <span aria-hidden>/</span>
              </span>
            ))}
          </nav>
        )}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-xl font-semibold break-words max-md:text-lg">
              {page.isFolder && <Folder className="size-5 shrink-0 text-muted" aria-hidden />}
              {page.title}
            </h2>
            {!page.isFolder && (
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <ActorAvatar actor={page.updatedBy} />
                <span>
                  Editada por {authorship(page.updatedBy, page.onBehalfOfUserId)} ·{" "}
                  <time dateTime={new Date(page.updatedAt).toISOString()} title={formatDateTime(page.updatedAt)}>
                    {formatRelative(page.updatedAt)}
                  </time>{" "}
                  · versão {page.version}
                </span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1 max-md:hidden">{actions}</div>
        </div>
        {!editing ? (
          <Tabs label="Seções da página" tabs={tabs} value={aba === "editar" ? "pagina" : aba} onChange={setAba} className="mt-2 border-b-0" />
        ) : (
          <div className="h-3" />
        )}
      </div>

      {page.deleted && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line bg-warning-soft px-3 py-2 text-sm md:px-5">
          <span className="min-w-0 flex-1">Esta página está na lixeira. Restaure para editar.</span>
          <Button
            size="sm"
            onClick={() =>
              api
                .restoreWikiPage(ws, page.id)
                .then(() => load())
                .then(() => toast.success("Página restaurada."))
                .catch(toast.error)
            }
          >
            Restaurar
          </Button>
        </div>
      )}
      {remoteNotice && editing && !conflict && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line bg-warning-soft px-3 py-2 text-sm md:px-5">
          <span className="min-w-0 flex-1">
            {authorship(remoteNotice.updatedBy, remoteNotice.onBehalfOfUserId)} acabou de salvar uma versão nova (v{remoteNotice.version}). Seu rascunho está guardado; ao
            salvar, você escolhe o que fazer.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setRemoteNotice(null)}>
            Entendi
          </Button>
        </div>
      )}

      {editing && draft ? (
        <>
          {saveError && (
            <div className="px-3 pt-3 md:px-5">
              <InlineError message={saveError} />
            </div>
          )}
          <WikiEditor
            ws={ws}
            pages={pages}
            draft={draft}
            onChange={updateDraft}
            onSave={(note) => void save(note)}
            onCancel={() => (dirty ? setConfirmCancel(true) : finishEditing())}
            saving={saving}
            conflict={conflict}
            onReloadConflict={() => {
              const latest = conflict!;
              drafts.clear(ws, pageId);
              setPage(latest);
              setDraft({ title: latest.title, body: latest.body, baseVersion: latest.version });
              setConflict(null);
              setRemoteNotice(null);
              setRecovered(false);
              toast.info("Você está editando a versão mais nova.");
            }}
            onOverwrite={(note) => {
              const latest = conflict!;
              setConflict(null);
              void save(note, latest.version);
            }}
            recovered={recovered}
            onDiscardRecovered={() => {
              drafts.clear(ws, pageId);
              setDraft({ title: page.title, body: page.body, baseVersion: page.version });
              setRecovered(false);
            }}
          />
        </>
      ) : (
        <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6 md:py-6">
            {page.isFolder ? (
              <FolderContents ws={ws} items={children} onCreate={() => onCreateIn(page.id)} />
            ) : aba === "historico" ? (
              <WikiHistory ws={ws} page={page} pages={pages} onRestored={(p) => { savedVersion.current = p.version; setPage(p); setAba("pagina"); }} />
            ) : aba === "estatisticas" ? (
              <WikiStats ws={ws} page={page} />
            ) : page.body.trim() ? (
              <WikiMarkdown text={page.body} pages={pages} ws={ws} />
            ) : (
              <EmptyState icon={<FileText className="size-5" />} title="Página em branco" action={<Button variant="primary" onClick={() => setAba("editar")}>Escrever</Button>} />
            )}
          </div>
        </div>
      )}

      <Popover open={menu} onClose={() => setMenu(false)} anchor={menuAnchor} align="end" label="Opções da página" className="w-56 py-1 max-md:w-auto">
        <div role="menu">
          <MenuItem icon={<TextCursorInput className="size-4" />} onClick={() => { setMenu(false); setMeta("rename"); }}>
            Renomear
          </MenuItem>
          <MenuItem icon={<FolderInput className="size-4" />} onClick={() => { setMenu(false); setMeta("move"); }}>
            Mover para…
          </MenuItem>
          {page.isFolder && (
            <MenuItem icon={<FilePlus2 className="size-4" />} onClick={() => { setMenu(false); onCreateIn(page.id); }}>
              Nova página aqui
            </MenuItem>
          )}
          <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => { setMenu(false); setConfirmDelete(true); }}>
            Mandar para a lixeira
          </MenuItem>
        </div>
      </Popover>
      {meta && (
        <EditMetaDialog
          ws={ws}
          page={page}
          pages={pages}
          mode={meta}
          onClose={() => setMeta(null)}
          onSaved={(p) => {
            savedVersion.current = p.version;
            setPage(p);
            setMeta(null);
            if (draft) setDraft({ ...draft, title: p.title, baseVersion: p.version });
            toast.success(meta === "rename" ? "Nome alterado." : "Página movida.");
          }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
        danger
        title={`Mandar “${page.title}” para a lixeira?`}
        body={page.isFolder ? "A pasta e tudo o que está dentro vão para a lixeira. Dá para restaurar depois." : "Dá para restaurar depois, pela lixeira."}
        confirmLabel="Mandar para a lixeira"
      />
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          finishEditing();
        }}
        danger
        title="Descartar as alterações?"
        body="O que você escreveu desde a última vez que salvou será perdido."
        confirmLabel="Descartar"
      />
    </>
  );
}

function FolderContents({ ws, items, onCreate }: { ws: string; items: WikiPageDTO[]; onCreate: () => void }) {
  if (items.length === 0)
    return (
      <EmptyState icon={<Folder className="size-5" />} title="Pasta vazia" action={<Button variant="primary" onClick={onCreate}>Nova página aqui</Button>}>
        Crie uma página ou mova páginas para cá.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {items.map((p) => (
        <li key={p.id}>
          <Link to={paths.wiki(ws, p.id)} className="flex items-center gap-3 px-3 py-3 hover:bg-surface-2 md:px-4">
            {p.isFolder ? <Folder className="size-4 shrink-0 text-muted" aria-hidden /> : <FileText className="size-4 shrink-0 text-muted" aria-hidden />}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.title}</span>
            {!p.isFolder && <span className="text-xs text-subtle">{formatRelative(p.updatedAt)}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
