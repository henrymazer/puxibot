import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cspFromHeaders, cspProblems, directive, inlineScriptHashes } from "./csp";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const headers = read("../../public/_headers");
const csp = cspFromHeaders(headers);

describe("CSP dos assets (public/_headers)", () => {
  it("tem a CSP e os cabeçalhos de segurança para todas as rotas", () => {
    expect(headers).toMatch(/^\/\*$/m);
    expect(csp).toBeTruthy();
    expect(headers).toMatch(/^\s+X-Content-Type-Options: nosniff$/m);
    expect(headers).toMatch(/^\s+Referrer-Policy: strict-origin-when-cross-origin$/m);
    expect(headers).toMatch(/^\s+X-Frame-Options: DENY$/m);
    expect(directive(csp!, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp!, "object-src")).toEqual(["'none'"]);
    expect(directive(csp!, "base-uri")).toEqual(["'none'"]);
    expect(directive(csp!, "connect-src")).toEqual(["'self'"]);
  });

  it("index.html e offline.html não têm script inline fora da CSP nem onclick", () => {
    expect(cspProblems(read("../../index.html"), csp!, "index.html")).toEqual([]);
    expect(cspProblems(read("../../public/offline.html"), csp!, "offline.html")).toEqual([]);
  });

  it("detecta script inline sem hash e handler inline", () => {
    const html = '<html><head><script>alert(1)</script></head><body><button onclick="x()">x</button></body></html>';
    const problems = cspProblems(html, csp!, "teste.html");
    expect(problems.some((p) => p.includes("sha256-"))).toBe(true);
    expect(problems.some((p) => p.includes("onclick"))).toBe(true);
    const [hash] = inlineScriptHashes(html);
    const withHash = csp!.replace("script-src 'self'", `script-src 'self' ${hash}`);
    expect(cspProblems('<script>alert(1)</script>', withHash, "t")).toEqual([]);
  });

  it("o service worker pré-carrega os scripts que substituíram os inline", () => {
    const sw = read("../../public/sw.js");
    expect(sw).toContain('"/theme.js"');
    expect(sw).toContain('"/offline.js"');
  });
});
