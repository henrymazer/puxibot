import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64UrlToUint8Array, isIos } from "./push";

type Logic = {
  resolveLink: (link: string | null, ws: string | undefined, origin: string) => string;
  summarize: (list: unknown[], origin: string) => { title: string; body: string; url: string; count: number };
};

/** Carrega a lógica pura do service worker (public/sw.js) num `self` falso. */
function loadSw(): Logic {
  const src = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  const fakeSelf: Record<string, unknown> = { addEventListener: () => undefined, location: { origin: "https://hub.x" } };
  new Function("self", "caches", src)(fakeSelf, {});
  return fakeSelf.__tbLogic as Logic;
}

describe("service worker: links e resumo das notificações", () => {
  const sw = loadSw();
  const O = "https://hub.x";
  it("resolve links relativos ao workspace, completos e absolutos", () => {
    expect(sw.resolveLink("/w/ws1/c/c1", "ws2", O)).toBe("/w/ws1/c/c1");
    expect(sw.resolveLink("/c/c1", "ws1", O)).toBe("/w/ws1/c/c1");
    expect(sw.resolveLink("aprovacoes", "ws1", O)).toBe("/w/ws1/aprovacoes");
    expect(sw.resolveLink("https://hub.x/w/ws1/tarefas?tarefa=t1", "ws1", O)).toBe("/w/ws1/tarefas?tarefa=t1");
    expect(sw.resolveLink("https://outro.site/x", "ws1", O)).toBe("/w/ws1");
    expect(sw.resolveLink(null, "ws1", O)).toBe("/w/ws1");
    expect(sw.resolveLink(null, undefined, O)).toBe("/");
  });
  it("resume só as não lidas, a mais nova primeiro, sem conteúdo de mensagem", () => {
    const list = [
      { id: "1", title: "Bruno mencionou você em #geral", body: "segredo", link: "/c/c1", read: false, createdAt: 10, workspaceId: "ws1" },
      { id: "2", title: "Tito pediu sua aprovação", body: "segredo", link: "/aprovacoes", read: false, createdAt: 20, workspaceId: "ws1" },
      { id: "3", title: "Lida", link: null, read: true, createdAt: 30, workspaceId: "ws1" },
    ];
    const n = sw.summarize(list, O);
    expect(n).toEqual({ title: "Puxibot", body: "Você tem 2 novidades. Última: Tito pediu sua aprovação", url: "/w/ws1/aprovacoes", count: 2 });
    expect(n.body).not.toContain("segredo");
    expect(sw.summarize([list[0]], O).body).toBe("Bruno mencionou você em #geral");
  });
  it("sem lista (falha de rede) ainda mostra aviso genérico", () => {
    expect(sw.summarize(undefined as unknown as unknown[], O)).toMatchObject({ body: "Você tem novidades no Puxibot.", url: "/", count: 0 });
  });
});

describe("helpers de push", () => {
  it("converte chave VAPID base64url em bytes", () => {
    expect([...base64UrlToUint8Array("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
    expect(base64UrlToUint8Array("BEl6").length).toBe(3);
  });
  it("detecta iPhone e iPad (que se diz Mac)", () => {
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isIos("Mozilla/5.0 (Linux; Android 14)", 5)).toBe(false);
  });
});
