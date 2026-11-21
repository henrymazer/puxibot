import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  Eye,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  Loader2,
  MoreVertical,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { FileDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, LoadingState } from "../../components/ui";
import { MenuItem, Popover } from "../../components/Popover";
import { toast } from "../../components/toast";
import { isAdmin } from "../../lib/actors";
import { formatBytes, formatRelative, formatDateTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { PageHeader } from "../shell/PageHeader";
import { useWsId } from "../shell/hooks";
import { allFolders, breadcrumb, childFolders, countInFolder, folderName, MAX_UPLOAD_BYTES, normalizeFolder, visibleFiles } from "./driveModel";
import { FileAuthor, FileOrigin, FileThumb, KindIcon } from "./FileBits";
import { FilePreview } from "./FilePreview";
import { MoveDialog, NewFolderDialog, RenameDialog } from "./FileDialogs";

type View = "grade" | "lista";

interface Upload {
  key: number;
  name: string;
  size: number;
  status: "sending" | "done" | "error";
  error?: string;
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

let uploadSeq = 0;

export function DrivePage() {
  const ws = useWsId();
  const filesMap = useWorkspace((s) => s.files);
  const loaded = useWorkspace((s) => s.filesLoaded);
  const loadFiles = useWorkspace((s) => s.loadFiles);
  const [params, setParams] = useSearchParams();
  const current = normalizeFolder(params.get("pasta"));
  const previewId = params.get("arquivo");
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>(() => readLocal<View>("tb-drive-view", "grade"));
  const [localFolders, setLocalFolders] = useState<string[]>(() => readLocal<string[]>(`tb-drive-folders:${ws}`, []));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "rename" | "move" | "delete"; file: FileDTO } | { kind: "folder" } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const load = useCallback(() => {
    setError(null);
    loadFiles().catch((e) => setError(errorMessage(e)));
  }, [loadFiles]);
  useEffect(load, [load]);

  const files = useMemo(() => Object.values(filesMap), [filesMap]);
  const folders = useMemo(() => allFolders(files, localFolders), [files, localFolders]);
  const subfolders = q.trim() ? [] : childFolders(folders, current);
  const visible = useMemo(() => visibleFiles(files, current, q), [files, current, q]);

  const setParam = (key: string, value: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (value) n.set(key, value);
      else n.delete(key);
      return n;
    });
  const openFolder = (path: string) => {
    setQ("");
    setParam("pasta", path || null);
  };
  const openPreview = (f: FileDTO) => setParam("arquivo", f.id);
  const closePreview = () => setParam("arquivo", null);

  // Link (busca, notificação) para um arquivo que não está mais no drive.
  const previewFile = previewId ? (filesMap[previewId] ?? null) : null;
  useEffect(() => {
    if (!previewId || !loaded || filesMap[previewId]) return;
    toast.info("Esse arquivo não está mais no drive.");
    setParam("arquivo", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId, loaded]);

  const changeView = (v: View) => {
    setView(v);
    writeLocal("tb-drive-view", v);
  };
  const addLocalFolder = (path: string) => {
    const next = [...new Set([...localFolders, path])];
    setLocalFolders(next);
    writeLocal(`tb-drive-folders:${ws}`, next);
  };

  // ---------- Envio ----------
  const upload = async (list: FileList | File[]) => {
    const arr = [...list];
    if (arr.length === 0) return;
    const folder = current || undefined;
    for (const file of arr) {
      const key = ++uploadSeq;
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploads((u) => [...u, { key, name: file.name, size: file.size, status: "error", error: "Maior que 25 MB. Envie um arquivo menor." }]);
        continue;
      }
      setUploads((u) => [...u, { key, name: file.name, size: file.size, status: "sending" }]);
      try {
        const f = await api.uploadFile(ws, file, { folder, inDrive: true });
        if (f && f.id) useWorkspace.getState().dispatch({ type: "file.created", file: { ...f, inDrive: true } });
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, status: "done" } : x)));
        setTimeout(() => setUploads((u) => u.filter((x) => x.key !== key)), 4000);
      } catch (e) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, status: "error", error: errorMessage(e) } : x)));
      }
    }
  };

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void upload(e.dataTransfer.files);
  };

  // ---------- Ações ----------
  const patchLocal = (f: FileDTO) => useWorkspace.setState((s) => ({ files: { ...s.files, [f.id]: f } }));
  const rename = async (file: FileDTO, name: string) => {
    const updated = await api.updateFile(ws, file.id, { name });
    patchLocal(updated && updated.id ? updated : { ...file, name });
    setDialog(null);
    toast.success("Arquivo renomeado.");
  };
  const move = async (file: FileDTO, folder: string | null) => {
    const updated = await api.updateFile(ws, file.id, { folder });
    patchLocal(updated && updated.id ? updated : { ...file, folder });
    setDialog(null);
    toast.success(folder ? `Movido para ${folderName(folder)}.` : "Movido para o drive.");
  };
  const remove = async (file: FileDTO) => {
    try {
      await api.deleteFile(ws, file.id);
      useWorkspace.setState((s) => {
        const { [file.id]: _gone, ...rest } = s.files;
        return { files: rest };
      });
      if (previewId === file.id) closePreview();
      toast.success("Arquivo apagado.");
    } catch (e) {
      toast.error(e);
    } finally {
      setDialog(null);
    }
  };

  const crumbs = breadcrumb(current);
  const isEmptyFolder = loaded && visible.length === 0 && subfolders.length === 0;

  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <PageHeader
        title="Drive"
        icon={<FolderOpen className="size-5" />}
        subtitle={loaded ? `${files.length} ${files.length === 1 ? "arquivo" : "arquivos"} de pessoas e agentes` : undefined}
        actions={
          <>
            <div role="group" aria-label="Visualização" className="mr-1 hidden rounded-md border border-line bg-surface-2 p-0.5 sm:inline-flex">
              <ViewButton active={view === "grade"} label="Grade" onClick={() => changeView("grade")}>
                <LayoutGrid className="size-4" />
              </ViewButton>
              <ViewButton active={view === "lista"} label="Lista" onClick={() => changeView("lista")}>
                <List className="size-4" />
              </ViewButton>
            </div>
            <Button variant="ghost" size="sm" icon={<FolderPlus className="size-4" />} onClick={() => setDialog({ kind: "folder" })} className="max-sm:hidden">
              Nova pasta
            </Button>
            <IconButton label="Nova pasta" onClick={() => setDialog({ kind: "folder" })} className="sm:hidden">
              <FolderPlus className="size-4.5" />
            </IconButton>
            <Button variant="primary" size="sm" icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>
              Enviar
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              aria-label="Escolher arquivos para enviar"
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        }
      />

      <div className="flex flex-col gap-2 border-b border-line bg-surface px-3 py-2 sm:flex-row sm:items-center md:px-5">
        <nav aria-label="Pastas" className="tb-scroll min-w-0 flex-1 overflow-x-auto">
          <ol className="flex items-center gap-0.5 text-sm whitespace-nowrap">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <li key={c.path || "root"} className="flex items-center gap-0.5">
                  {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-subtle" aria-hidden />}
                  {last ? (
                    <span aria-current="page" className="px-1.5 font-semibold">
                      {c.label}
                    </span>
                  ) : (
                    <button type="button" onClick={() => openFolder(c.path)} className="min-h-8 rounded-sm px-1.5 text-muted hover:bg-surface-2 hover:text-ink max-md:min-h-10">
                      {c.label}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <span className="sr-only">Buscar arquivos</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar em todo o drive" className="tb-input h-9 min-h-9 pl-8 max-md:h-11" />
          </label>
          <div role="group" aria-label="Visualização" className="inline-flex shrink-0 rounded-md border border-line bg-surface-2 p-0.5 sm:hidden">
            <ViewButton active={view === "grade"} label="Grade" onClick={() => changeView("grade")}>
              <LayoutGrid className="size-4" />
            </ViewButton>
            <ViewButton active={view === "lista"} label="Lista" onClick={() => changeView("lista")}>
              <List className="size-4" />
            </ViewButton>
          </div>
        </div>
      </div>

      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl p-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-5">
          {error && !loaded ? (
            <ErrorState message={error} onRetry={load} />
          ) : !loaded ? (
            <LoadingState label="Carregando o drive…" />
          ) : (
            <>
              {q.trim() && (
                <p className="mb-3 text-sm text-muted" role="status">
                  {visible.length === 0 ? "Nada encontrado" : `${visible.length} ${visible.length === 1 ? "arquivo encontrado" : "arquivos encontrados"}`} em todo o drive.
                </p>
              )}
              {subfolders.length > 0 && (
                <section aria-label="Pastas" className="mb-5">
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {subfolders.map((f) => {
                      const n = countInFolder(files, f);
                      return (
                        <li key={f}>
                          <button
                            type="button"
                            onClick={() => openFolder(f)}
                            className="flex min-h-12 w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left hover:border-line-strong hover:bg-surface-2"
                          >
                            <Folder className="size-5 shrink-0 text-primary" aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{folderName(f)}</span>
                              <span className="block text-xs text-muted">{n === 0 ? "vazia" : n === 1 ? "1 arquivo" : `${n} arquivos`}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {isEmptyFolder ? (
                <EmptyState
                  icon={<FolderOpen className="size-5" />}
                  title={q.trim() ? "Nenhum arquivo com esse nome" : current ? "Pasta vazia" : "Nenhum arquivo ainda"}
                  action={
                    !q.trim() && (
                      <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>
                        Enviar arquivos
                      </Button>
                    )
                  }
                  className="mt-6"
                >
                  {q.trim() ? "Tente outra palavra." : "Arraste arquivos para cá ou use o botão Enviar. O que os agentes salvarem também aparece aqui."}
                </EmptyState>
              ) : view === "grade" ? (
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-label="Arquivos">
                  {visible.map((f) => (
                    <li key={f.id}>
                      <GridCard ws={ws} file={f} showFolder={!!q.trim()} onOpen={() => openPreview(f)} onAction={(kind) => setDialog({ kind, file: f })} />
                    </li>
                  ))}
                </ul>
              ) : (
                <FileTable ws={ws} files={visible} showFolder={!!q.trim()} onOpen={openPreview} onAction={(kind, f) => setDialog({ kind, file: f })} />
              )}
              <p className="mt-6 text-center text-xs text-subtle max-md:hidden">Arraste arquivos para esta tela para enviar{current ? ` para ${folderName(current)}` : ""}. Até 25 MB por arquivo.</p>
            </>
          )}
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[var(--tb-overlay)] p-6" aria-hidden>
          <div className="tb-anim-pop flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-elevated px-10 py-8 text-center shadow-pop">
            <Upload className="size-8 text-primary" />
            <p className="text-base font-semibold">Solte para enviar</p>
            <p className="text-sm text-muted">para {current ? folderName(current) : "o drive do time"}</p>
          </div>
        </div>
      )}

      {uploads.length > 0 && <UploadTray uploads={uploads} onDismiss={(key) => setUploads((u) => u.filter((x) => x.key !== key))} />}

      {previewFile && <FilePreview ws={ws} file={previewFile} onClose={closePreview} />}
      {dialog?.kind === "rename" && <RenameDialog file={dialog.file} onClose={() => setDialog(null)} onSave={(n) => rename(dialog.file, n).catch((e) => Promise.reject(new Error(errorMessage(e))))} />}
      {dialog?.kind === "move" && (
        <MoveDialog
          file={dialog.file}
          folders={folders}
          onClose={() => setDialog(null)}
          onMove={(f) => move(dialog.file, f).catch((e) => Promise.reject(new Error(errorMessage(e))))}
        />
      )}
      {dialog?.kind === "folder" && (
        <NewFolderDialog
          parent={current}
          existing={folders}
          onClose={() => setDialog(null)}
          onCreate={(path) => {
            addLocalFolder(path);
            setDialog(null);
            openFolder(path);
          }}
        />
      )}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(null)}
        onConfirm={() => dialog?.kind === "delete" && void remove(dialog.file)}
        danger
        title="Apagar arquivo?"
        confirmLabel="Apagar"
        body={dialog?.kind === "delete" ? `“${dialog.file.name}” some do drive para todo mundo. Mensagens que tinham o arquivo anexado deixam de abrir.` : ""}
      />
    </div>
  );
}

function ViewButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("inline-flex size-8 items-center justify-center rounded-sm max-md:size-10", active ? "bg-elevated text-ink shadow-soft" : "text-muted hover:text-ink")}
    >
      {children}
    </button>
  );
}

type Action = "rename" | "move" | "delete";

function useCanChange(file: FileDTO): boolean {
  const me = useWorkspace((s) => s.me);
  if (!me) return false;
  return isAdmin(me.role) || (file.author.type === "user" && file.author.id === me.userId);
}

function FileMenu({ ws, file, onOpen, onAction, className }: { ws: string; file: FileDTO; onOpen: () => void; onAction: (a: Action) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const canChange = useCanChange(file);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <>
      <IconButton ref={anchor} size="sm" label={`Ações de ${file.name}`} onClick={(e) => (e.stopPropagation(), setOpen((v) => !v))} className={className}>
        <MoreVertical className="size-4" />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" label={`Ações de ${file.name}`} className="w-56 py-1">
        <div role="menu">
          <MenuItem icon={<Eye className="size-4" />} onClick={pick(onOpen)}>
            Abrir
          </MenuItem>
          <a
            role="menuitem"
            href={api.fileUrl(ws, file.id)}
            download={file.name}
            onClick={() => setOpen(false)}
            className="flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2 max-md:min-h-12"
          >
            <Download className="size-4 text-muted" aria-hidden />
            Baixar
          </a>
          <MenuItem icon={<Pencil className="size-4" />} onClick={pick(() => onAction("rename"))} disabled={!canChange}>
            Renomear
          </MenuItem>
          <MenuItem icon={<FolderInput className="size-4" />} onClick={pick(() => onAction("move"))} disabled={!canChange}>
            Mover para…
          </MenuItem>
          <MenuItem icon={<Trash2 className="size-4" />} danger onClick={pick(() => onAction("delete"))} disabled={!canChange}>
            Apagar
          </MenuItem>
          {!canChange && <p className="px-3 pt-1 pb-2 text-xs text-subtle">Só quem enviou ou um admin muda este arquivo.</p>}
        </div>
      </Popover>
    </>
  );
}

function GridCard({ ws, file, showFolder, onOpen, onAction }: { ws: string; file: FileDTO; showFolder: boolean; onOpen: () => void; onAction: (a: Action) => void }) {
  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface hover:border-line-strong">
      <button type="button" onClick={onOpen} className="block text-left" aria-label={`Abrir ${file.name}`}>
        <FileThumb ws={ws} file={file} className="aspect-[4/3] w-full border-b border-line" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        <div className="flex items-start gap-1">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left" title={file.name}>
            <span className="line-clamp-2 text-sm font-medium break-all">{file.name}</span>
          </button>
          <FileMenu ws={ws} file={file} onOpen={onOpen} onAction={onAction} className="-mt-1 -mr-1 size-8" />
        </div>
        <div className="min-w-0 text-xs text-muted">
          <FileAuthor file={file} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-subtle">
          <time dateTime={new Date(file.createdAt).toISOString()} title={formatDateTime(file.createdAt)}>
            {formatRelative(file.createdAt)}
          </time>
          {file.channelId && (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">
                <FileOrigin ws={ws} file={file} />
              </span>
            </>
          )}
          {showFolder && file.folder && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-0.5 truncate">
                <Folder className="size-3" aria-hidden />
                {folderName(file.folder)}
              </span>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function FileTable({
  ws,
  files,
  showFolder,
  onOpen,
  onAction,
}: {
  ws: string;
  files: FileDTO[];
  showFolder: boolean;
  onOpen: (f: FileDTO) => void;
  onAction: (a: Action, f: FileDTO) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full table-fixed text-sm">
        <thead className="border-b border-line bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Nome</th>
            <th scope="col" className="hidden w-52 px-3 py-2 font-medium md:table-cell">Autor</th>
            <th scope="col" className="hidden w-40 px-3 py-2 font-medium lg:table-cell">Origem</th>
            <th scope="col" className="hidden w-32 px-3 py-2 font-medium sm:table-cell">Data</th>
            <th scope="col" className="hidden w-24 px-3 py-2 text-right font-medium sm:table-cell">Tamanho</th>
            <th scope="col" className="w-12 px-1 py-2"><span className="sr-only">Ações</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {files.map((f) => (
            <tr key={f.id} className="hover:bg-surface-2/60">
              <td className="px-3 py-2">
                <button type="button" onClick={() => onOpen(f)} className="flex w-full min-w-0 items-center gap-2.5 text-left max-md:min-h-11">
                  {f.mime.startsWith("image/") ? (
                    <FileThumb ws={ws} file={f} className="size-9 shrink-0 rounded-md border border-line" />
                  ) : (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                      <KindIcon file={f} className="size-4.5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{f.name}</span>
                    <span className="block truncate text-xs text-muted md:hidden">
                      {formatRelative(f.createdAt)} · {formatBytes(f.size)}
                    </span>
                    {showFolder && f.folder && <span className="block truncate text-xs text-subtle">em {f.folder}</span>}
                  </span>
                </button>
              </td>
              <td className="hidden px-3 py-2 text-xs text-muted md:table-cell">
                <FileAuthor file={f} />
              </td>
              <td className="hidden truncate px-3 py-2 text-xs lg:table-cell">
                <FileOrigin ws={ws} file={f} fallback={<span className="text-subtle">drive</span>} />
              </td>
              <td className="hidden px-3 py-2 text-xs text-muted sm:table-cell" title={formatDateTime(f.createdAt)}>
                {formatRelative(f.createdAt)}
              </td>
              <td className="hidden px-3 py-2 text-right text-xs text-muted tabular-nums sm:table-cell">{formatBytes(f.size)}</td>
              <td className="px-1 py-2 text-right">
                <FileMenu ws={ws} file={f} onOpen={() => onOpen(f)} onAction={(a) => onAction(a, f)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UploadTray({ uploads, onDismiss }: { uploads: Upload[]; onDismiss: (key: number) => void }) {
  const sending = uploads.filter((u) => u.status === "sending").length;
  return (
    <section
      aria-label="Envios"
      aria-live="polite"
      className="tb-anim-pop absolute right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 z-10 rounded-lg border border-line bg-elevated shadow-pop sm:left-auto sm:w-80"
    >
      <header className="border-b border-line px-3 py-2 text-sm font-semibold">{sending ? `Enviando ${sending} ${sending === 1 ? "arquivo" : "arquivos"}…` : "Envios"}</header>
      <ul className="tb-scroll max-h-56 overflow-y-auto">
        {uploads.map((u) => (
          <li key={u.key} className="flex items-start gap-2 px-3 py-2 text-sm">
            {u.status === "sending" ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-label="Enviando" />
            ) : u.status === "done" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Enviado" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Erro" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{u.name}</span>
              <span className={cn("block text-xs", u.status === "error" ? "text-danger" : "text-muted")}>
                {u.status === "error" ? u.error : u.status === "done" ? "Enviado" : formatBytes(u.size)}
              </span>
            </span>
            {u.status !== "sending" && (
              <IconButton size="sm" label="Dispensar" onClick={() => onDismiss(u.key)} className="-my-1 size-8">
                <X className="size-4" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

