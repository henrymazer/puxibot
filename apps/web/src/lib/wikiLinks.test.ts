import { describe, expect, it } from "vitest";
import { extractWikiLinks, findWikiLinks, normalizeTitle, renameWikiLinks, splitWikiLinks, titleIndex } from "./wikiLinks";

describe("findWikiLinks", () => {
  it("acha [[Título]] e [[Título|texto]]", () => {
    expect(findWikiLinks("Veja [[Processo de deploy]] e [[Clientes|a lista]].")).toEqual([
      { title: "Processo de deploy", label: "Processo de deploy", start: 5, end: 27 },
      { title: "Clientes", label: "a lista", start: 30, end: 50 },
    ]);
  });
  it("ignora colchetes vazios, quebras de linha e aninhados", () => {
    expect(findWikiLinks("[[ ]] [[a\nb]] [[x[y]]]")).toEqual([]);
  });
});

describe("extractWikiLinks", () => {
  it("tira repetidos (sem diferenciar acento e caixa) e ignora código", () => {
    const body = "[[Preços]] e [[precos]]\n\n`[[Falso]]`\n\n```\n[[Também falso]]\n```\n\n[[Onboarding]]";
    expect(extractWikiLinks(body)).toEqual(["Preços", "Onboarding"]);
  });
});

describe("resolução e renomeação", () => {
  it("normaliza títulos e monta índice só de páginas ativas", () => {
    expect(normalizeTitle("  Guia   de Estilo ÁGIL ")).toBe("guia de estilo agil");
    const idx = titleIndex([
      { id: "1", title: "Guia" },
      { id: "2", title: "Pasta", isFolder: true },
      { id: "3", title: "Velha", deleted: true },
    ]);
    expect([...idx.entries()]).toEqual([["guia", "1"]]);
  });
  it("renomeia links mantendo o texto mostrado", () => {
    expect(renameWikiLinks("[[Guia]] e [[guia|o guia]] e [[Outro]]", "Guia", "Manual")).toBe("[[Manual]] e [[Manual|o guia]] e [[Outro]]");
  });
  it("gera nós de link para o markdown, marcando páginas que não existem", () => {
    const nodes = splitWikiLinks("ver [[Guia]] ou [[Nova]]!", {
      resolve: (t) => (t === "Guia" ? "/w/x/wiki/1" : null),
      createHref: (t) => `/w/x/wiki?nova=${encodeURIComponent(t)}`,
    });
    expect(nodes.map((n) => n.type)).toEqual(["text", "link", "text", "link", "text"]);
    expect(nodes[1]!.url).toBe("/w/x/wiki/1");
    expect(nodes[3]!.url).toBe("/w/x/wiki?nova=Nova");
    expect(String(nodes[3]!.data!.hProperties!.className)).toContain("missing");
  });
});
