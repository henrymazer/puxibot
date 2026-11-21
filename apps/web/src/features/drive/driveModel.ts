/** Regras puras do drive: tipo de arquivo, pastas (caminhos "A/B") e ordenação. Testado em driveModel.test.ts. */
import type { FileDTO } from "@puxibot/shared";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type FileKind = "image" | "pdf" | "markdown" | "text" | "audio" | "video" | "sheet" | "archive" | "other";

const TEXT_EXT = /\.(txt|log|csv|tsv|json|ya?ml|xml|ts|tsx|js|jsx|mjs|py|rb|go|rs|java|sh|sql|css|html?|ini|toml|env)$/i;

export function fileKind(mime: string, name: string): FileKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (m === "text/markdown" || /\.(md|markdown)$/i.test(name)) return "markdown";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (/spreadsheet|excel|csv/.test(m) || /\.(xlsx?|ods|csv)$/i.test(name)) return /\.csv$/i.test(name) || m === "text/csv" ? "text" : "sheet";
  if (/zip|tar|gzip|compressed|7z|rar/.test(m) || /\.(zip|tar|gz|tgz|7z|rar)$/i.test(name)) return "archive";
  if (m.startsWith("text/") || m === "application/json" || m === "application/xml" || TEXT_EXT.test(name)) return "text";
  return "other";
}

/** Dá para pré-visualizar dentro do Puxibot. */
export function canPreview(kind: FileKind): boolean {
  return kind === "image" || kind === "pdf" || kind === "markdown" || kind === "text" || kind === "audio" || kind === "video";
}

/** Normaliza um caminho de pasta: sem barras sobrando, sem partes vazias. "" = raiz. */
export function normalizeFolder(path: string | null | undefined): string {
  return (path ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");
}

/** Todas as pastas conhecidas (inclusive as intermediárias de "A/B/C"), em ordem alfabética. */
export function allFolders(files: Pick<FileDTO, "folder">[], extra: string[] = []): string[] {
  const set = new Set<string>();
  for (const raw of [...files.map((f) => f.folder), ...extra]) {
    const parts = normalizeFolder(raw).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Subpastas diretas de `current`. */
export function childFolders(folders: string[], current: string): string[] {
  const base = normalizeFolder(current);
  const prefix = base ? `${base}/` : "";
  const out = new Set<string>();
  for (const f of folders) {
    if (!f.startsWith(prefix) || f === base) continue;
    const rest = f.slice(prefix.length);
    if (!rest) continue;
    out.add(prefix + rest.split("/")[0]);
  }
  return [...out].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Migalhas: [{label:"Drive", path:""}, {label:"A", path:"A"}, {label:"B", path:"A/B"}]. */
export function breadcrumb(current: string): { label: string; path: string }[] {
  const parts = normalizeFolder(current).split("/").filter(Boolean);
  return [{ label: "Drive", path: "" }, ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join("/") }))];
}

export function folderName(path: string): string {
  const parts = normalizeFolder(path).split("/");
  return parts[parts.length - 1] || "Drive";
}

/** Quantos arquivos há dentro da pasta (incluindo subpastas). */
export function countInFolder(files: Pick<FileDTO, "folder">[], path: string): number {
  const base = normalizeFolder(path);
  return files.filter((f) => {
    const p = normalizeFolder(f.folder);
    return p === base || p.startsWith(`${base}/`);
  }).length;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Arquivos visíveis: com busca, procura em todas as pastas; sem busca, só os da pasta atual.
 * Mais novos primeiro.
 */
export function visibleFiles<T extends Pick<FileDTO, "folder" | "name" | "createdAt">>(files: T[], current: string, q: string): T[] {
  const term = norm(q.trim());
  const base = normalizeFolder(current);
  return files
    .filter((f) => (term ? norm(f.name).includes(term) : normalizeFolder(f.folder) === base))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Valida o nome de uma pasta nova (sem "/"). */
export function folderNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Dê um nome à pasta.";
  if (n.includes("/")) return "Use um nome sem barra (/).";
  if (n.length > 60) return "Use até 60 caracteres.";
  return null;
}
