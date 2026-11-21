/** Árvore da wiki (pastas e páginas) a partir da lista plana. Funções puras, testadas em tree.test.ts. */
import type { WikiPageDTO } from "@puxibot/shared";
import { normalizeTitle } from "../../lib/wikiLinks";

export interface TreeNode {
  page: WikiPageDTO;
  children: TreeNode[];
}

const byKindAndTitle = (a: WikiPageDTO, b: WikiPageDTO) =>
  Number(b.isFolder) - Number(a.isFolder) || a.title.localeCompare(b.title, "pt-BR");

/** Monta a árvore só com páginas ativas. Página com pai inexistente ou apagado vai para a raiz. */
export function buildTree(pages: WikiPageDTO[]): TreeNode[] {
  const active = pages.filter((p) => !p.deleted);
  const ids = new Set(active.map((p) => p.id));
  const kids = new Map<string | null, WikiPageDTO[]>();
  for (const p of active) {
    const parent = p.parentId && ids.has(p.parentId) && p.parentId !== p.id ? p.parentId : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push(p);
  }
  const seen = new Set<string>();
  const make = (parent: string | null): TreeNode[] =>
    (kids.get(parent) ?? [])
      .filter((p) => !seen.has(p.id))
      .sort(byKindAndTitle)
      .map((p) => {
        seen.add(p.id);
        return { page: p, children: make(p.id) };
      });
  return make(null);
}

/** Mantém o que combina com a busca e os ancestrais; pasta que combina mantém tudo dentro. */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = normalizeTitle(query);
  if (!q) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (normalizeTitle(n.page.title).includes(q)) out.push(n);
    else {
      const children = filterTree(n.children, query);
      if (children.length) out.push({ page: n.page, children });
    }
  }
  return out;
}

/** Pastas acima da página, da raiz até o pai. */
export function ancestors(pages: WikiPageDTO[], id: string): WikiPageDTO[] {
  const map = new Map(pages.map((p) => [p.id, p]));
  const out: WikiPageDTO[] = [];
  let cur = map.get(id)?.parentId ?? null;
  const guard = new Set<string>();
  while (cur && map.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const p = map.get(cur)!;
    out.unshift(p);
    cur = p.parentId;
  }
  return out;
}

export function descendantIds(pages: WikiPageDTO[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const p of pages) {
      if (p.parentId === pid && !out.has(p.id)) {
        out.add(p.id);
        walk(p.id);
      }
    }
  };
  walk(id);
  return out;
}

/** Pastas para escolher destino (com profundidade), sem a própria página e o que está dentro dela. */
export function folderOptions(pages: WikiPageDTO[], exclude?: string): { id: string; title: string; depth: number }[] {
  const banned = exclude ? new Set([exclude, ...descendantIds(pages, exclude)]) : new Set<string>();
  const out: { id: string; title: string; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if (!n.page.isFolder || banned.has(n.page.id)) continue;
      out.push({ id: n.page.id, title: n.page.title, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(buildTree(pages), 0);
  return out;
}
