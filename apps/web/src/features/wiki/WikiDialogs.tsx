import { useState, type FormEvent } from "react";
import { FileText, Folder } from "lucide-react";
import type { WikiPageDTO } from "@puxibot/shared";
import { api, ApiClientError, errorMessage } from "../../api";
import { cn } from "../../lib/cn";
import { Button, Field, InlineError, Input, Modal, Select } from "../../components/ui";
import { folderOptions } from "./tree";

function FolderSelect({ id, value, onChange, pages, exclude, describedBy }: { id: string; value: string; onChange: (v: string) => void; pages: WikiPageDTO[]; exclude?: string; describedBy?: string }) {
  const options = folderOptions(pages, exclude);
  return (
    <Select id={id} aria-describedby={describedBy} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Início da wiki (sem pasta)</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {" ".repeat(o.depth)}
          {o.title}
        </option>
      ))}
    </Select>
  );
}

export function CreateDialog({
  ws,
  pages,
  initialKind,
  initialTitle = "",
  initialParent = "",
  onClose,
  onCreated,
}: {
  ws: string;
  pages: WikiPageDTO[];
  initialKind: "page" | "folder";
  initialTitle?: string;
  initialParent?: string;
  onClose: () => void;
  onCreated: (p: WikiPageDTO) => void;
}) {
  const [kind, setKind] = useState(initialKind);
  const [title, setTitle] = useState(initialTitle);
  const [parent, setParent] = useState(initialParent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError(kind === "folder" ? "Dê um nome à pasta." : "Dê um título à página.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createWikiPage(ws, {
        title: title.trim(),
        isFolder: kind === "folder",
        parentId: parent || null,
        body: kind === "page" ? `# ${title.trim()}\n\n` : undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === "folder" ? "Nova pasta" : "Nova página"}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="wiki-create" loading={busy}>
            Criar
          </Button>
        </>
      }
    >
      <form id="wiki-create" onSubmit={submit} className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Tipo" className="grid grid-cols-2 gap-2">
          {(
            [
              ["page", "Página", FileText],
              ["folder", "Pasta", Folder],
            ] as const
          ).map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "flex h-11 items-center justify-center gap-2 rounded-md border text-sm font-medium",
                kind === k ? "border-primary bg-primary-soft text-primary-text" : "border-line-strong bg-surface hover:bg-surface-2",
              )}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
        <Field label={kind === "folder" ? "Nome da pasta" : "Título"}>
          {(id, d) => <Input id={id} aria-describedby={d} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-autofocus />}
        </Field>
        <Field label="Dentro de" hint="Você pode mover depois.">
          {(id, d) => <FolderSelect id={id} describedBy={d} value={parent} onChange={setParent} pages={pages} />}
        </Field>
        <InlineError message={error} />
      </form>
    </Modal>
  );
}

/** Renomear e mover usam o mesmo PATCH com `baseVersion`. */
export function EditMetaDialog({
  ws,
  page,
  pages,
  mode,
  onClose,
  onSaved,
}: {
  ws: string;
  page: WikiPageDTO;
  pages: WikiPageDTO[];
  mode: "rename" | "move";
  onClose: () => void;
  onSaved: (p: WikiPageDTO) => void;
}) {
  const [title, setTitle] = useState(page.title);
  const [parent, setParent] = useState(page.parentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === "rename" && !title.trim()) {
      setError("O título não pode ficar vazio.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateWikiPage(
        ws,
        page.id,
        mode === "rename" ? { title: title.trim(), baseVersion: page.version } : { parentId: parent || null, baseVersion: page.version },
      );
      onSaved(saved);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 409
          ? "Alguém editou esta página agora há pouco. Feche, veja a versão nova e tente de novo."
          : errorMessage(err),
      );
      setBusy(false);
    }
  };

  const what = page.isFolder ? "pasta" : "página";
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={mode === "rename" ? `Renomear ${what}` : `Mover “${page.title}”`}
      description={mode === "rename" && !page.isFolder ? "Links [[com o título antigo]] em outras páginas não mudam sozinhos." : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="wiki-meta" loading={busy}>
            {mode === "rename" ? "Renomear" : "Mover"}
          </Button>
        </>
      }
    >
      <form id="wiki-meta" onSubmit={submit} className="flex flex-col gap-4">
        {mode === "rename" ? (
          <Field label="Título">{(id, d) => <Input id={id} aria-describedby={d} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-autofocus />}</Field>
        ) : (
          <Field label="Mover para">{(id, d) => <FolderSelect id={id} describedBy={d} value={parent} onChange={setParent} pages={pages} exclude={page.id} />}</Field>
        )}
        <InlineError message={error} />
      </form>
    </Modal>
  );
}
