import { useState } from "react";
import { Folder, FolderPlus, HardDrive } from "lucide-react";
import type { FileDTO } from "@puxibot/shared";
import { Button, Field, InlineError, Input, Modal } from "../../components/ui";
import { cn } from "../../lib/cn";
import { folderNameError, normalizeFolder } from "./driveModel";

export function RenameDialog({ file, onClose, onSave }: { file: FileDTO; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const n = name.trim();
    if (!n) return setError("O nome não pode ficar vazio.");
    if (n === file.name) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onSave(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Renomear arquivo"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Nome" error={error}>
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              value={name}
              data-autofocus
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => {
                const dot = e.target.value.lastIndexOf(".");
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

export function MoveDialog({
  file,
  folders,
  onClose,
  onMove,
}: {
  file: FileDTO;
  folders: string[];
  onClose: () => void;
  onMove: (folder: string | null) => Promise<void>;
}) {
  const current = normalizeFolder(file.folder);
  const [target, setTarget] = useState<string>(current);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    let dest = target;
    if (creating) {
      const err = folderNameError(newName);
      if (err) return setError(err);
      dest = normalizeFolder(target ? `${target}/${newName}` : newName);
    }
    if (dest === current) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onMove(dest || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const options = ["", ...folders];
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Mover para…"
      description={file.name}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Mover
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Pasta de destino" className="flex flex-col gap-1">
        {options.map((f) => {
          const depth = f ? f.split("/").length - 1 : 0;
          return (
            <button
              key={f || "__root"}
              type="button"
              role="radio"
              aria-checked={target === f}
              onClick={() => setTarget(f)}
              className={cn(
                "flex min-h-10 items-center gap-2 rounded-md px-2.5 text-left text-sm max-md:min-h-12",
                target === f ? "bg-primary-soft font-medium text-primary-text" : "hover:bg-surface-2",
              )}
              style={{ paddingLeft: 10 + depth * 18 }}
            >
              {f ? <Folder className="size-4 shrink-0" aria-hidden /> : <HardDrive className="size-4 shrink-0" aria-hidden />}
              <span className="truncate">{f ? f.split("/").pop() : "Drive (sem pasta)"}</span>
              {f === current && <span className="ml-auto text-xs text-subtle">atual</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 border-t border-line pt-3">
        {creating ? (
          <Field label={`Nova pasta dentro de ${target ? target.split("/").pop() : "Drive"}`} error={error}>
            {(id, d) => <Input id={id} aria-describedby={d} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} autoFocus />}
          </Field>
        ) : (
          <Button variant="ghost" size="sm" icon={<FolderPlus className="size-4" />} onClick={() => setCreating(true)}>
            Nova pasta aqui
          </Button>
        )}
        {!creating && <InlineError message={error} />}
      </div>
    </Modal>
  );
}

export function NewFolderDialog({ parent, existing, onClose, onCreate }: { parent: string; existing: string[]; onClose: () => void; onCreate: (path: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const err = folderNameError(name);
    if (err) return setError(err);
    const path = normalizeFolder(parent ? `${parent}/${name}` : name);
    if (existing.includes(path)) return setError("Já existe uma pasta com esse nome aqui.");
    onCreate(path);
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Nova pasta"
      description={parent ? `Dentro de ${parent}` : "No drive do time"}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit}>
            Criar pasta
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Nome da pasta" error={error} hint="A pasta fica salva quando você enviar ou mover um arquivo para ela.">
          {(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-autofocus placeholder="Ex.: Contratos" />}
        </Field>
      </form>
    </Modal>
  );
}
