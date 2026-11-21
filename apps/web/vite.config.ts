import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cspFromHeaders, cspProblems } from "./src/pwa/csp";

/**
 * Preenche a versão e a lista de pré-cache do service worker (public/sw.js) depois do build.
 * A versão é um hash do conteúdo publicado: qualquer mudança gera um service worker novo,
 * e o navegador oferece a atualização.
 */
function serviceWorker(): Plugin {
  let outDir = "dist";
  let files: string[] = [];
  return {
    name: "puxibot-service-worker",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    writeBundle(_opts, bundle) {
      files = Object.keys(bundle);
    },
    closeBundle() {
      const swPath = join(outDir, "sw.js");
      if (!existsSync(swPath)) return;
      const assets = files.filter((f) => f.startsWith("assets/") && !f.endsWith(".map")).map((f) => `/${f}`);
      const icons = existsSync(join(outDir, "icons")) ? readdirSync(join(outDir, "icons")).map((f) => `/icons/${f}`) : [];
      const list = ["/", "/offline.html", "/offline.js", "/theme.js", "/manifest.webmanifest", "/favicon.svg", ...icons, ...assets.sort()];
      const hash = createHash("sha256");
      for (const f of ["index.html", "offline.html", "offline.js", "theme.js", "manifest.webmanifest", ...assets.map((a) => a.slice(1))]) {
        const p = join(outDir, f);
        if (existsSync(p)) hash.update(f).update(readFileSync(p));
      }
      const version = hash.digest("hex").slice(0, 12);
      const src = readFileSync(swPath, "utf8")
        .replace("__TB_VERSION__", version)
        .replace(/\/\*__TB_PRECACHE__\*\/\s*\[[^\]]*\]/, JSON.stringify(list));
      writeFileSync(swPath, src);
    },
  };
}

/**
 * Confere o build contra a CSP de public/_headers: um <script> inline sem hash em script-src,
 * ou um onclick=..., quebraria a página em produção sem nenhum aviso. Falha o build.
 */
function cspGuard(): Plugin {
  let outDir = "dist";
  return {
    name: "puxibot-csp-guard",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const headersPath = join(outDir, "_headers");
      if (!existsSync(headersPath)) throw new Error("dist/_headers não foi gerado (public/_headers sumiu?)");
      const csp = cspFromHeaders(readFileSync(headersPath, "utf8"));
      if (!csp) throw new Error("public/_headers sem Content-Security-Policy");
      const problems = readdirSync(outDir)
        .filter((f) => f.endsWith(".html"))
        .flatMap((f) => cspProblems(readFileSync(join(outDir, f), "utf8"), csp, f));
      if (problems.length) throw new Error(`CSP: ${problems.join("; ")}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker(), cspGuard()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
