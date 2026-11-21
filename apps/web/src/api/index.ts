/**
 * Escolhe o backend: hub real ou, só em desenvolvimento, o modo demonstração
 * (dados falsos em memória por trás do mesmo ApiClient).
 */
import { ApiClient } from "./client";
import type { SocketFactory } from "../realtime/connection";

export let api = new ApiClient();
export let socketFactory: SocketFactory | undefined;
export let isDemo = false;

const DEMO_KEY = "tb-demo";

function wantsDemo(): boolean {
  if (import.meta.env.MODE === "demo") return true;
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("demo") === "0") {
      sessionStorage.removeItem(DEMO_KEY);
      return false;
    }
    if (params.has("demo")) {
      sessionStorage.setItem(DEMO_KEY, "1");
      return true;
    }
    return sessionStorage.getItem(DEMO_KEY) === "1";
  } catch {
    return false;
  }
}

export async function initApi(): Promise<void> {
  if (import.meta.env.DEV && wantsDemo()) {
    const { createDemoBackend } = await import("../demo/backend");
    const backend = createDemoBackend();
    api = new ApiClient({ fetch: backend.fetch, fileUrl: backend.fileUrl });
    socketFactory = backend.createSocket;
    isDemo = true;
  }
}

export { ApiClientError, errorMessage } from "./client";
