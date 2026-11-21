import { describe, expect, it } from "vitest";
import { allFolders, breadcrumb, childFolders, countInFolder, fileKind, folderNameError, normalizeFolder, visibleFiles } from "./driveModel";

describe("fileKind", () => {
  it("classifica pelo tipo e pela extensão", () => {
    expect(fileKind("image/png", "a.png")).toBe("image");
    expect(fileKind("application/pdf", "x")).toBe("pdf");
    expect(fileKind("application/octet-stream", "Contrato.PDF")).toBe("pdf");
    expect(fileKind("text/markdown", "notas")).toBe("markdown");
    expect(fileKind("", "LEIAME.md")).toBe("markdown");
    expect(fileKind("text/plain", "erro.log")).toBe("text");
    expect(fileKind("application/octet-stream", "dados.json")).toBe("text");
    expect(fileKind("text/csv", "vendas.csv")).toBe("text");
    expect(fileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "vendas.xlsx")).toBe("sheet");
    expect(fileKind("application/zip", "pacote.zip")).toBe("archive");
    expect(fileKind("application/octet-stream", "binario.bin")).toBe("other");
  });
});

describe("pastas", () => {
  const files = [{ folder: "Marketing/Campanhas" }, { folder: "Marketing" }, { folder: " Contratos/ " }, { folder: null }];
  it("normaliza caminhos", () => {
    expect(normalizeFolder(" /A//B/ ")).toBe("A/B");
    expect(normalizeFolder(null)).toBe("");
  });
  it("lista pastas, inclusive intermediárias e as criadas só na interface", () => {
    expect(allFolders(files, ["Novos/Rascunhos"])).toEqual(["Contratos", "Marketing", "Marketing/Campanhas", "Novos", "Novos/Rascunhos"]);
  });
  it("acha subpastas diretas e monta a migalha", () => {
    const all = allFolders(files);
    expect(childFolders(all, "")).toEqual(["Contratos", "Marketing"]);
    expect(childFolders(all, "Marketing")).toEqual(["Marketing/Campanhas"]);
    expect(breadcrumb("Marketing/Campanhas")).toEqual([
      { label: "Drive", path: "" },
      { label: "Marketing", path: "Marketing" },
      { label: "Campanhas", path: "Marketing/Campanhas" },
    ]);
    expect(countInFolder(files, "Marketing")).toBe(2);
  });
  it("mostra só a pasta atual, ou todas na busca (sem acento)", () => {
    const list = [
      { id: "1", name: "Relatório.pdf", folder: "Marketing", createdAt: 1 },
      { id: "2", name: "logo.png", folder: null, createdAt: 3 },
      { id: "3", name: "relatorio-2.pdf", folder: null, createdAt: 2 },
    ];
    expect(visibleFiles(list, "", "").map((f) => f.id)).toEqual(["2", "3"]);
    expect(visibleFiles(list, "", "relat").map((f) => f.id)).toEqual(["3", "1"]);
  });
  it("valida nome de pasta", () => {
    expect(folderNameError(" ")).toMatch(/nome/);
    expect(folderNameError("a/b")).toMatch(/barra/);
    expect(folderNameError("Fotos")).toBeNull();
  });
});
