/** Web Push neste aparelho: suporte, permissão, inscrição e cancelamento. */
import { api } from "../api";
import { usePwa } from "./register";

/** Chave VAPID (base64url) -> bytes para `applicationServerKey`. */
export function base64UrlToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isIos(ua = navigator.userAgent, maxTouchPoints = navigator.maxTouchPoints ?? 0): boolean {
  // iPadOS se apresenta como Mac; o toque denuncia.
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export type PushPermission = NotificationPermission | "unsupported";
export function pushPermission(): PushPermission {
  return "Notification" in window ? Notification.permission : "unsupported";
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  const reg = usePwa.getState().registration;
  if (reg) return reg;
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await readyRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export class PushError extends Error {}

/** Pede permissão, inscreve o aparelho e manda a inscrição ao hub. */
export async function enablePush(vapidKey: string): Promise<void> {
  const reg = await readyRegistration();
  if (!reg) throw new PushError("Este navegador ainda não preparou o Puxibot para avisos. Recarregue a página e tente de novo.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new PushError("Sem permissão para mostrar avisos neste aparelho.");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(vapidKey) });
  const json = sub.toJSON();
  await api.subscribePush({ endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await api.unsubscribePush(endpoint);
}
