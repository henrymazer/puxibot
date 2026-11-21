/**
 * Registro do service worker e aviso de versão nova.
 * Só em produção e fora do modo demonstração (que roda com dados falsos no próprio navegador).
 */
import { create } from "zustand";
import { isDemo } from "../api";

interface PwaState {
  /** Service worker ativo (necessário para Web Push). */
  registration: ServiceWorkerRegistration | null;
  /** Há uma versão nova instalada esperando para entrar. */
  waiting: ServiceWorker | null;
  applyUpdate: () => void;
  dismissUpdate: () => void;
}

export const usePwa = create<PwaState>((set, get) => ({
  registration: null,
  waiting: null,
  applyUpdate() {
    const w = get().waiting;
    if (!w) return;
    reloadOnChange = true;
    w.postMessage({ type: "SKIP_WAITING" });
  },
  dismissUpdate() {
    set({ waiting: null });
  },
}));

let reloadOnChange = false;

export function swEnabled(): boolean {
  return import.meta.env.PROD && !isDemo && typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

export async function registerServiceWorker(): Promise<void> {
  if (!swEnabled()) return;
  const sw = navigator.serviceWorker;
  // Só recarrega quando a pessoa pediu a atualização (não na primeira instalação).
  sw.addEventListener("controllerchange", () => {
    if (reloadOnChange) location.reload();
  });
  // Clique numa notificação quando o navegador não deixa o service worker navegar a aba.
  sw.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type === "NAVIGATE" && typeof d.url === "string" && d.url.startsWith("/")) location.assign(d.url);
  });
  try {
    const reg = await sw.register("/sw.js", { scope: "/" });
    usePwa.setState({ registration: reg });
    const track = (w: ServiceWorker | null) => {
      if (!w) return;
      const check = () => {
        // "installed" com um controlador ativo = versão nova esperando.
        if (w.state === "installed" && sw.controller) usePwa.setState({ waiting: w });
      };
      check();
      w.addEventListener("statechange", check);
    };
    track(reg.waiting);
    track(reg.installing);
    reg.addEventListener("updatefound", () => track(reg.installing));
    // Confere versão nova ao voltar para a aba e a cada hora.
    const update = () => void reg.update().catch(() => undefined);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") update();
    });
    setInterval(update, 60 * 60 * 1000);
  } catch {
    /* sem service worker a interface funciona igual, só sem modo offline e push */
  }
}
