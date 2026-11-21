import { useMemo, useState } from "react";
import { Link, NavLink, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, Network, Search, Trash2 } from "lucide-react";
import type { WikiPageDTO } from "@puxibot/shared";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { Button, IconButton, Input, Spinner } from "../../components/ui";
import { buildTree, filterTree, type TreeNode } from "./tree";

const COLLAPSED_KEY = "tb-wiki-collapsed";
const footerLink = "flex h-9 flex-1 items-center justify-center gap-2 rounded-md text-sm text-muted hover:bg-surface-2 hover:text-ink max-md:h-11";

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = { ...c, [id]: !c[id] };
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  return { collapsed, toggle };
}

/** Painel com busca e árvore de pastas e páginas. */
export function WikiTree({
  ws,
  pages,
  activeId,
  onCreate,
}: {
  ws: string;
  pages: WikiPageDTO[] | null;
  activeId?: string;
  onCreate: (kind: "page" | "folder") => void;
}) {
  const [q, setQ] = useState("");
  const { collapsed, toggle } = useCollapsed();
  const tree = useMemo(() => filterTree(buildTree(pages ?? []), q), [pages, q]);
  const searching = q.trim().length > 0;
  const [params] = useSearchParams();
  const view = params.get("visao");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar páginas"
            aria-label="Buscar páginas da wiki"
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" icon={<FilePlus2 className="size-4" />} onClick={() => onCreate("page")} className="flex-1">
            Nova página
          </Button>
          <Button size="sm" icon={<FolderPlus className="size-4" />} onClick={() => onCreate("folder")}>
            Pasta
          </Button>
        </div>
      </div>
      <nav aria-label="Páginas da wiki" className="tb-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {pages === null ? (
          <Spinner className="m-3" />
        ) : tree.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">{searching ? "Nenhuma página com esse título." : "A wiki está vazia. Crie a primeira página."}</p>
        ) : (
          <ul className="space-y-px">
            {tree.map((n) => (
              <TreeItem key={n.page.id} ws={ws} node={n} depth={0} activeId={activeId} collapsed={collapsed} onToggle={toggle} forceOpen={searching} />
            ))}
          </ul>
        )}
      </nav>
      <div className="flex gap-1 border-t border-line p-2">
        <Link
          to={`${paths.wiki(ws)}?visao=grafo`}
          aria-current={view === "grafo" ? "page" : undefined}
          className={cn(footerLink, view === "grafo" && "bg-sidebar-active text-sidebar-active-text")}
        >
          <Network className="size-4" aria-hidden /> Grafo
        </Link>
        <Link
          to={`${paths.wiki(ws)}?visao=lixeira`}
          aria-current={view === "lixeira" ? "page" : undefined}
          className={cn(footerLink, view === "lixeira" && "bg-sidebar-active text-sidebar-active-text")}
        >
          <Trash2 className="size-4" aria-hidden /> Lixeira
        </Link>
      </div>
    </div>
  );
}

function TreeItem({
  ws,
  node,
  depth,
  activeId,
  collapsed,
  onToggle,
  forceOpen,
}: {
  ws: string;
  node: TreeNode;
  depth: number;
  activeId?: string;
  collapsed: Record<string, boolean>;
  onToggle: (id: string) => void;
  forceOpen: boolean;
}) {
  const p = node.page;
  const open = forceOpen || !collapsed[p.id];
  const active = p.id === activeId;
  const pad = { paddingLeft: 4 + depth * 14 };
  return (
    <li>
      <div
        className={cn(
          "group flex h-8 items-center gap-0.5 rounded-md text-sm max-md:h-11",
          active ? "bg-sidebar-active font-medium text-sidebar-active-text" : "text-ink/85 hover:bg-surface-2",
        )}
        style={pad}
      >
        {p.isFolder ? (
          <IconButton
            size="sm"
            label={open ? `Recolher ${p.title}` : `Abrir ${p.title}`}
            aria-expanded={open}
            onClick={() => onToggle(p.id)}
            className="size-6 max-md:size-9"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </IconButton>
        ) : (
          <span className="w-6 shrink-0 max-md:w-9" aria-hidden />
        )}
        <NavLink
          to={paths.wiki(ws, p.id)}
          aria-current={active ? "page" : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pr-2"
        >
          {p.isFolder ? (
            open ? <FolderOpen className="size-4 shrink-0 text-muted" aria-hidden /> : <Folder className="size-4 shrink-0 text-muted" aria-hidden />
          ) : (
            <FileText className="size-4 shrink-0 text-muted" aria-hidden />
          )}
          <span className="truncate">{p.title}</span>
          {p.isFolder && node.children.length > 0 && <span className="ml-auto text-xs text-subtle">{node.children.length}</span>}
        </NavLink>
      </div>
      {p.isFolder && open && node.children.length > 0 && (
        <ul className="space-y-px">
          {node.children.map((c) => (
            <TreeItem key={c.page.id} ws={ws} node={c} depth={depth + 1} activeId={activeId} collapsed={collapsed} onToggle={onToggle} forceOpen={forceOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}
