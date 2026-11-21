import { describe, expect, it } from "vitest";
import type { WikiPageDTO } from "@puxibot/shared";
import { ancestors, buildTree, descendantIds, filterTree, folderOptions } from "./tree";

const p = (id: string, title: string, parentId: string | null = null, extra: Partial<WikiPageDTO> = {}): WikiPageDTO => ({
  id, parentId, title, isFolder: false, body: "", version: 1, deleted: false, updatedBy: { type: "user", id: "u" }, onBehalfOfUserId: null, createdAt: 0, updatedAt: 0, ...extra,
});
const pages = [
  p("f1", "Processos", null, { isFolder: true }),
  p("f2", "Sub", "f1", { isFolder: true }),
  p("a", "Deploy", "f1"),
  p("b", "Árvore", "f2"),
  p("c", "Glossário"),
  p("d", "Órfã", "sumiu"),
  p("e", "Velha", "f1", { deleted: true }),
];

describe("buildTree", () => {
  it("pastas primeiro, ordem alfabética, órfãs na raiz e sem apagadas", () => {
    const t = buildTree(pages);
    expect(t.map((n) => n.page.id)).toEqual(["f1", "c", "d"]);
    expect(t[0]!.children.map((n) => n.page.id)).toEqual(["f2", "a"]);
    expect(t[0]!.children[0]!.children.map((n) => n.page.id)).toEqual(["b"]);
  });
});

describe("filterTree", () => {
  it("mantém ancestrais do que combina, sem acento", () => {
    const t = filterTree(buildTree(pages), "arvore");
    expect(t.map((n) => n.page.id)).toEqual(["f1"]);
    expect(t[0]!.children[0]!.children.map((n) => n.page.id)).toEqual(["b"]);
    expect(filterTree(buildTree(pages), "")).toHaveLength(3);
  });
});

describe("ancestors, descendentes e destinos", () => {
  it("monta o caminho até a raiz e evita mover para dentro de si", () => {
    expect(ancestors(pages, "b").map((x) => x.id)).toEqual(["f1", "f2"]);
    expect([...descendantIds(pages, "f1")].sort()).toEqual(["a", "b", "e", "f2"]);
    expect(folderOptions(pages, "f1")).toEqual([]);
    expect(folderOptions(pages, "a")).toEqual([
      { id: "f1", title: "Processos", depth: 0 },
      { id: "f2", title: "Sub", depth: 1 },
    ]);
  });
});
