/**
 * Links entre páginas da wiki no formato [[Título]] ou [[Título|texto mostrado]].
 * Usado para navegar, para o plugin de markdown e para conferir o grafo. Testado em wikiLinks.test.ts.
 */

const LINK_RX = /\[\[([^[\]|\n]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/g;

export interface WikiLinkMatch {
  title: string;
  label: string;
  start: number;
  end: number;
}

/** Título normalizado para comparar: sem acento, minúsculo, espaços simples. */
export function normalizeTitle(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Acha os [[links]] num trecho de texto simples (sem markdown de código). */
export function findWikiLinks(text: string): WikiLinkMatch[] {
  const out: WikiLinkMatch[] = [];
  for (const m of text.matchAll(LINK_RX)) {
    const title = m[1]!.trim();
    if (!title) continue;
    out.push({ title, label: (m[2] ?? m[1]!).trim(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Remove blocos e trechos de código, onde [[...]] não é link. */
export function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** Títulos citados no corpo, sem repetição (comparando o título normalizado), na ordem em que aparecem. */
export function extractWikiLinks(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of findWikiLinks(stripCode(body))) {
    const k = normalizeTitle(l.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l.title);
  }
  return out;
}

/** Índice título normalizado -> id, para resolver links. */
export function titleIndex(pages: { id: string; title: string; isFolder?: boolean; deleted?: boolean }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of pages) {
    if (p.isFolder || p.deleted) continue;
    const k = normalizeTitle(p.title);
    if (!map.has(k)) map.set(k, p.id);
  }
  return map;
}

/** Troca [[Antigo]] por [[Novo]] (mantendo o texto mostrado), ex.: ao renomear uma página. */
export function renameWikiLinks(body: string, oldTitle: string, newTitle: string): string {
  const target = normalizeTitle(oldTitle);
  return body.replace(LINK_RX, (all, title: string, label?: string) => {
    if (normalizeTitle(title) !== target) return all;
    return label !== undefined ? `[[${newTitle}|${label}]]` : `[[${newTitle}]]`;
  });
}

// ---------- Plugin remark ----------
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

export interface WikiLinkOptions {
  /** Devolve o endereço da página, ou null se ela não existe (vira link "criar página"). */
  resolve: (title: string) => string | null;
  /** Endereço para criar a página que ainda não existe. */
  createHref?: (title: string) => string;
}

export function splitWikiLinks(value: string, opts: WikiLinkOptions): MdNode[] {
  const links = findWikiLinks(value);
  if (links.length === 0) return [{ type: "text", value }];
  const out: MdNode[] = [];
  let last = 0;
  for (const l of links) {
    if (l.start > last) out.push({ type: "text", value: value.slice(last, l.start) });
    const href = opts.resolve(l.title);
    const missing = href === null;
    out.push({
      type: "link",
      url: href ?? opts.createHref?.(l.title) ?? "#",
      children: [{ type: "text", value: l.label }],
      data: { hProperties: { className: missing ? "tb-wikilink tb-wikilink-missing" : "tb-wikilink", "data-wiki": l.title } },
    });
    last = l.end;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walk(node: MdNode, opts: WikiLinkOptions) {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("[[")) next.push(...splitWikiLinks(child.value, opts));
    else {
      if (child.type !== "code" && child.type !== "inlineCode" && child.type !== "link") walk(child, opts);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkWikiLinks(options: WikiLinkOptions) {
  return (tree: MdNode) => walk(tree, options);
}
