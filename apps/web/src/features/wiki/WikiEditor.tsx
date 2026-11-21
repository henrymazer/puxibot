import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Eye, RefreshCw, Save } from "lucide-react";
import type { WikiPageDTO } from "@puxibot/shared";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Button, Input, Kbd, Textarea } from "../../components/ui";
import { WikiMarkdown } from "./WikiMarkdown";
import { useAuthorship } from "./shared";

export interface Draft {
  title: string;
  body: string;
  /** Versão da página quando a edição começou (vai como `baseVersion`). */
  baseVersion: number;
}

const draftKey = (ws: string, id: string) => `tb-wiki-draft:${ws}:${id}`;

/** Rascunho guardado no aparelho enquanto não é salvo (sobrevive a recarregar a aba). */
export const drafts = {
  load(ws: string, id: string): (Draft & { savedAt: number }) | null {
    try {
      const raw = localStorage.getItem(draftKey(ws, id));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  save(ws: string, id: string, d: Draft) {
    try {
      localStorage.setItem(draftKey(ws, id), JSON.stringify({ ...d, savedAt: Date.now() }));
    } catch {
      /* sem espaço: o rascunho continua na tela */
    }
  },
  clear(ws: string, id: string) {
    try {
      localStorage.removeItem(draftKey(ws, id));
    } catch {
      /* ignore */
    }
  },
};

export function WikiEditor({
  ws,
  pages,
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  conflict,
  onReloadConflict,
  onOverwrite,
  recovered,
  onDiscardRecovered,
}: {
  ws: string;
  pages: WikiPageDTO[];
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: (note: string) => void;
  onCancel: () => void;
  saving: boolean;
  /** Versão mais nova salva por outra pessoa ou agente (resposta 409). */
  conflict: WikiPageDTO | null;
  onReloadConflict: () => void;
  onOverwrite: (note: string) => void;
  recovered: boolean;
  onDiscardRecovered: () => void;
}) {
  const [mobileTab, setMobileTab] = useState<"edit" | "preview">("edit");
  const [note, setNote] = useState("");
  const [showTheirs, setShowTheirs] = useState(false);
  const authorship = useAuthorship();
  const saveRef = useRef(() => onSave(note));
  saveRef.current = () => (conflict ? undefined : onSave(note));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="tb-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
      {conflict && (
        <div role="alert" className="border-b border-line bg-warning-soft px-3 py-3 text-sm md:px-5">
          <p className="flex items-start gap-2 font-medium text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {authorship(conflict.updatedBy, conflict.onBehalfOfUserId)} salvou esta página às {formatDateTime(conflict.updatedAt)} (versão{" "}
              {conflict.version}), enquanto você editava.
            </span>
          </p>
          <p className="mt-1 text-muted">Seu texto continua aqui e não foi perdido. Escolha o que fazer:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" icon={<Eye className="size-4" />} onClick={() => setShowTheirs((v) => !v)} aria-expanded={showTheirs}>
              {showTheirs ? "Esconder a versão nova" : "Ver a versão nova"}
            </Button>
            <Button size="sm" icon={<RefreshCw className="size-4" />} onClick={onReloadConflict}>
              Recarregar (descartar o meu)
            </Button>
            <Button size="sm" variant="danger" onClick={() => onOverwrite(note)} loading={saving}>
              Sobrescrever com o meu
            </Button>
          </div>
          {showTheirs && (
            <div className="tb-scroll mt-3 max-h-64 overflow-y-auto rounded-md border border-line bg-surface p-3">
              <WikiMarkdown text={conflict.body} pages={pages} ws={ws} />
            </div>
          )}
        </div>
      )}
      {recovered && !conflict && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line bg-info-soft px-3 py-2 text-sm md:px-5">
          <span className="flex-1">Recuperamos um rascunho seu que não tinha sido salvo.</span>
          <Button size="sm" variant="ghost" onClick={onDiscardRecovered}>
            Descartar rascunho
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-2 px-3 pt-3 md:px-5">
        <label htmlFor="wiki-title" className="sr-only">
          Título
        </label>
        <Input
          id="wiki-title"
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          maxLength={200}
          className="text-lg font-semibold"
          placeholder="Título da página"
        />
        <div role="tablist" aria-label="Modo do editor" className="flex gap-1 border-b border-line lg:hidden">
          {(
            [
              ["edit", "Editar"],
              ["preview", "Visualizar"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={mobileTab === id}
              onClick={() => setMobileTab(id)}
              className={cn(
                "-mb-px h-11 border-b-2 px-3 text-sm font-medium",
                mobileTab === id ? "border-primary text-ink" : "border-transparent text-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-[50vh] flex-1 gap-4 px-3 py-3 md:px-5">
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", mobileTab !== "edit" && "max-lg:hidden")}>
          <label htmlFor="wiki-body" className="sr-only">
            Conteúdo em markdown
          </label>
          <Textarea
            id="wiki-body"
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            className="min-h-[40vh] flex-1 resize-none font-mono text-sm leading-relaxed"
            placeholder={"Escreva em markdown. Para ligar outra página use [[Título da página]]."}
          />
          <p className="mt-1 text-xs text-subtle">
            Markdown: <code className="font-mono"># título</code>, <code className="font-mono">**negrito**</code>, <code className="font-mono">- lista</code>. Link para
            outra página: <code className="font-mono">[[Título]]</code>.
          </p>
        </div>
        <div
          className={cn(
            "tb-scroll min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface p-4",
            mobileTab !== "preview" && "max-lg:hidden",
          )}
          aria-label="Pré-visualização"
        >
          <p className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase max-lg:hidden">Pré-visualização</p>
          {draft.body.trim() ? <WikiMarkdown text={draft.body} pages={pages} ws={ws} /> : <p className="text-sm text-muted">Nada para mostrar ainda.</p>}
        </div>
      </div>

      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center md:px-5">
        <label htmlFor="wiki-note" className="sr-only">
          O que mudou
        </label>
        <Input id="wiki-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="O que mudou? (opcional, aparece no histórico)" maxLength={200} className="sm:flex-1" />
        <div className="flex items-center justify-end gap-2">
          <span className="hidden text-xs text-subtle xl:inline">
            <Kbd>Ctrl</Kbd> <Kbd>S</Kbd> salva
          </span>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant="primary" icon={<Save className="size-4" />} onClick={() => onSave(note)} loading={saving && !conflict} disabled={!!conflict}>
            Salvar
          </Button>
        </div>
      </div>
    </div>
  );
}
