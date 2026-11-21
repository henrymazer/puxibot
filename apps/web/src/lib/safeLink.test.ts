import { describe, expect, it } from "vitest";
import { safeLink } from "./safeLink";

describe("safeLink", () => {
  it("aceita http(s) absoluto como link externo", () => {
    expect(safeLink("https://github.com/org/repo/pull/42")).toEqual({ kind: "external", href: "https://github.com/org/repo/pull/42" });
    expect(safeLink("http://exemplo.com")).toEqual({ kind: "external", href: "http://exemplo.com" });
    expect(safeLink("  HTTPS://exemplo.com/a  ")).toEqual({ kind: "external", href: "HTTPS://exemplo.com/a" });
  });

  it("aceita caminho relativo começando com /", () => {
    expect(safeLink("/w/ws1/aprovacoes")).toEqual({ kind: "internal", href: "/w/ws1/aprovacoes" });
  });

  it("recusa esquemas perigosos e endereços ambíguos", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "mailto:a@b.c",
      "//evil.example/x",
      "/\\evil.example",
      "https:/\\evil.example",
      "java\tscript:alert(1)",
      "https://",
      "w/ws1/aprovacoes",
      "exemplo.com",
      "",
      "   ",
    ]) {
      expect(safeLink(bad), bad).toBeNull();
    }
  });

  it("recusa valores que não são texto", () => {
    expect(safeLink(undefined)).toBeNull();
    expect(safeLink(null)).toBeNull();
    expect(safeLink(42)).toBeNull();
  });
});
