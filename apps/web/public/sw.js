/*
 * Service worker do Puxibot, escrito à mão.
 *
 * - Guarda o "shell" da interface (index.html, /assets/* com hash, ícones) num cache por versão.
 * - Nunca guarda nada de /api: dados sempre vêm do hub.
 * - Navegação: rede primeiro; sem rede, mostra a tela offline (offline.html).
 * - Atualização segura: a versão nova instala e espera; a página mostra "Nova versão disponível"
 *   e só troca quando a pessoa pede (mensagem SKIP_WAITING). Caches antigos são apagados ao ativar.
 * - Web Push sem conteúdo: ao receber um push, busca as notificações não lidas na API
 *   e mostra um aviso genérico com link para a tela certa.
 *
 * A versão e a lista de pré-cache são preenchidas no build (plugin em vite.config.ts).
 */
const VERSION = "__TB_VERSION__";
const PRECACHE = /*__TB_PRECACHE__*/ ["/", "/offline.html", "/offline.js", "/theme.js", "/manifest.webmanifest", "/favicon.svg", "/icons/icon.svg", "/icons/icon-192.png"];
const CACHE_PREFIX = "tb-shell-";
const CACHE = CACHE_PREFIX + VERSION;
const OFFLINE_URL = "/offline.html";

// ---------- Lógica pura (testada em src/pwa/sw.test.ts) ----------
const tbLogic = {
  /** Link de notificação -> caminho da interface. Relativo ao workspace quando não começa com /w/. */
  resolveLink(link, workspaceId, origin) {
    const home = workspaceId ? "/w/" + workspaceId : "/";
    if (!link) return home;
    if (/^https?:\/\//i.test(link)) {
      try {
        const u = new URL(link);
        if (u.origin !== origin) return home;
        link = u.pathname + u.search + u.hash;
      } catch (e) {
        return home;
      }
    }
    if (link.startsWith("/w/") || link === "/") return link;
    if (!workspaceId) return link.startsWith("/") ? link : "/" + link;
    return home + (link.startsWith("/") ? "" : "/") + link;
  },

  /** Monta o aviso a partir da lista de notificações (sem conteúdo de mensagem). */
  summarize(list, origin) {
    const unread = (Array.isArray(list) ? list : [])
      .filter((n) => n && !n.read)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (unread.length === 0) {
      return { title: "Puxibot", body: "Você tem novidades no Puxibot.", url: "/", count: 0 };
    }
    const first = unread[0];
    const url = tbLogic.resolveLink(first.link, first.workspaceId, origin);
    const label = first.title || "Novidade no Puxibot";
    const body = unread.length === 1 ? label : "Você tem " + unread.length + " novidades. Última: " + label;
    return { title: "Puxibot", body, url, count: unread.length };
  },
};
self.__tbLogic = tbLogic;

// ---------- Ciclo de vida ----------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Um arquivo que falhar não impede a instalação do resto.
      Promise.all(
        PRECACHE.map((url) =>
          fetch(new Request(url, { cache: "reload" }))
            .then((res) => (res.ok ? cache.put(url, clean(res)) : undefined))
            .catch(() => undefined),
        ),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "GET_VERSION" && event.source) event.source.postMessage({ type: "VERSION", version: VERSION });
});

// ---------- Requisições ----------
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Dados nunca passam pelo cache.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(navigate(req));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Arquivos com hash no nome não mudam: cache primeiro.
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.pathname === "/sw.js") return;
  event.respondWith(staleWhileRevalidate(req));
});

/**
 * O hub pode redirecionar /offline.html para /offline. Resposta "redirecionada" não pode
 * ser usada numa navegação, então guardamos uma cópia limpa.
 */
function clean(res) {
  if (!res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function navigate(req) {
  try {
    return await fetch(req);
  } catch (e) {
    const cache = await caches.open(CACHE);
    return (await cache.match(OFFLINE_URL)) || (await cache.match("/")) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => undefined);
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const update = fetch(req)
    .then((res) => {
      if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => undefined);
      return res;
    })
    .catch(() => undefined);
  return hit || (await update) || Response.error();
}

// ---------- Web Push sem conteúdo ----------
self.addEventListener("push", (event) => {
  event.waitUntil(showUnread());
});

async function showUnread() {
  let list = [];
  try {
    const res = await fetch("/api/me/notifications", { credentials: "include", cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      list = Array.isArray(data) ? data : (data && data.items) || [];
    }
  } catch (e) {
    /* sem rede ou sessão: mostra o aviso genérico */
  }
  const n = tbLogic.summarize(list, self.location.origin);
  // O navegador exige mostrar algo a cada push (userVisibleOnly).
  await self.registration.showNotification(n.title, {
    body: n.body,
    tag: "tb-novidades",
    renotify: true,
    icon: "/icons/icon-192.png",
    data: { url: n.url },
    lang: "pt-BR",
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        await client.focus();
        try {
          if (client.url !== target) await client.navigate(target);
        } catch (e) {
          client.postMessage({ type: "NAVIGATE", url: path });
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
