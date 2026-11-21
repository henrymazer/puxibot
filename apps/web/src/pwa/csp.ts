import { createHash } from "node:crypto";

/**
 * Checagens da CSP de public/_headers, usadas pelo teste (src/pwa/csp.test.ts) e pelo build
 * (vite.config.ts, sobre o dist/): todo <script> inline precisa ter o hash em script-src, e
 * nenhuma página pode ter atributo de evento inline (onclick=...), que a CSP bloqueia.
 */
export function cspFromHeaders(headersFile: string): string | null {
  const line = headersFile.split("\n").find((l) => /^\s+Content-Security-Policy:/i.test(l));
  return line ? line.replace(/^\s+Content-Security-Policy:\s*/i, "").trim() : null;
}

export function directive(csp: string, name: string): string[] | null {
  for (const part of csp.split(";")) {
    const [n, ...values] = part.trim().split(/\s+/);
    if (n?.toLowerCase() === name) return values;
  }
  return null;
}

export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/\btype\s*=\s*["']?(application\/(ld\+)?json|importmap)/i.test(attrs)) continue;
    out.push(`'sha256-${createHash("sha256").update(m[2] ?? "", "utf8").digest("base64")}'`);
  }
  return out;
}

/** Problemas de uma página contra a CSP; lista vazia = ok. */
export function cspProblems(html: string, csp: string, page: string): string[] {
  const problems: string[] = [];
  const scriptSrc = directive(csp, "script-src") ?? directive(csp, "default-src") ?? [];
  if (scriptSrc.includes("'unsafe-inline'")) problems.push("script-src não deve ter 'unsafe-inline'");
  for (const h of inlineScriptHashes(html)) {
    if (!scriptSrc.includes(h)) problems.push(`${page}: script inline sem o hash ${h} em script-src (public/_headers)`);
  }
  const handler = /<[a-z][^>]*\s(on[a-z]+)\s*=/i.exec(html);
  if (handler) problems.push(`${page}: atributo de evento inline "${handler[1]}" é bloqueado pela CSP`);
  return problems;
}
