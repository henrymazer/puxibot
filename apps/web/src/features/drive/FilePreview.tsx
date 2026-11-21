import { useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import type { FileDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { InlineError, Modal, Spinner } from "../../components/ui";
import { formatBytes, formatDateTime } from "../../lib/format";
import { Markdown } from "../chat/Markdown";
import { fileKind } from "./driveModel";
import { FileAuthor, FileOrigin, KIND_LABEL, KindIcon } from "./FileBits";

const MAX_TEXT = 400_000;

/** Pré-visualização: imagem, texto/markdown, PDF pelo leitor do navegador, áudio e vídeo. */
export function FilePreview({ ws, file, onClose }: { ws: string; file: FileDTO; onClose: () => void }) {
  const kind = fileKind(file.mime, file.name);
  const url = api.fileUrl(ws, file.id);
  /** Para mostrar aqui dentro e em outra aba; `url` (sem inline) baixa. */
  const viewUrl = api.fileUrl(ws, file.id, { inline: true });
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={file.name}
      description={`${KIND_LABEL[kind]} · ${formatBytes(file.size)}`}
      className="md:h-[min(90vh,880px)]"
      footer={
        <>
          <a
            href={viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-surface-2"
          >
            <ExternalLink className="size-4" aria-hidden />
            Abrir em outra aba
          </a>
          <a href={url} download={file.name} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover">
            <Download className="size-4" aria-hidden />
            Baixar
          </a>
        </>
      }
    >
      <div className="flex h-full min-h-[50vh] flex-col gap-3">
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          <div className="flex min-w-0 items-center gap-1.5">
            <dt className="sr-only">Autor</dt>
            <dd className="min-w-0">
              <FileAuthor file={file} />
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt>Origem:</dt>
            <dd>
              <FileOrigin ws={ws} file={file} fallback="enviado no drive" />
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt>Data:</dt>
            <dd>{formatDateTime(file.createdAt)}</dd>
          </div>
          {file.folder && (
            <div className="flex items-center gap-1">
              <dt>Pasta:</dt>
              <dd>{file.folder}</dd>
            </div>
          )}
        </dl>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-2">
          {kind === "image" ? (
            <div className="flex flex-1 items-center justify-center overflow-auto p-2">
              <img src={viewUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
            </div>
          ) : kind === "pdf" ? (
            <iframe src={viewUrl} title={`PDF ${file.name}`} className="min-h-[60vh] w-full flex-1 bg-white" />
          ) : kind === "markdown" || kind === "text" ? (
            <TextPreview url={viewUrl} markdown={kind === "markdown"} />
          ) : kind === "video" ? (
            <video src={viewUrl} controls className="max-h-full w-full flex-1 bg-black" />
          ) : kind === "audio" ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <audio src={viewUrl} controls className="w-full max-w-md" />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted">
              <KindIcon file={file} className="size-10" />
              <p>Não dá para pré-visualizar este tipo de arquivo aqui. Baixe para abrir no seu computador.</p>
              <a href={url} download={file.name} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover">
                <Download className="size-4" aria-hidden />
                Baixar ({formatBytes(file.size)})
              </a>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TextPreview({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    fetch(url, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "Arquivo não encontrado." : "Não deu para abrir o arquivo.");
        const t = await res.text();
        if (!alive) return;
        setCut(t.length > MAX_TEXT);
        setText(t.slice(0, MAX_TEXT));
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [url]);
  if (error) return <div className="p-4"><InlineError message={error} /></div>;
  if (text === null) return <div className="flex flex-1 items-center justify-center p-8"><Spinner label="Carregando arquivo" /></div>;
  return (
    <div className="tb-scroll flex-1 overflow-auto bg-surface p-4 md:p-6">
      {markdown ? <Markdown text={text} /> : <pre className="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">{text}</pre>}
      {cut && <p className="mt-4 text-xs text-muted">Arquivo grande: mostrando só o começo. Baixe para ver tudo.</p>}
    </div>
  );
}
