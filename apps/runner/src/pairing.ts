/** `puxibot login`: pareamento com o hub ou token colado à mão. */
import os from "node:os";
import type { RunnerPairPollResponse, RunnerPairStartResponse } from "@puxibot/shared";
import { saveToken, updateConfig } from "./config.js";

/** Hub no próprio computador (desenvolvimento): o único caso em que http:// é aceito. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function normalizeHubUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/.test(s) ? "http://" : "https://") + s;
  const u = new URL(s);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    throw new Error(
      `endereço do hub sem https (${u.origin}). O token do runner e os trabalhos passariam sem criptografia; use https:// (http:// só para um hub em localhost).`,
    );
  }
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<{ status: number; data: T | null; message: string | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const message = (data as { error?: { message?: string } } | null)?.error?.message ?? null;
  return { status: res.status, data: res.ok ? (data as T) : null, message };
}

export interface PairCallbacks {
  /** Mostra o código e o endereço para a pessoa aprovar. */
  onCode(code: string, approveUrl: string): void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PairResult {
  hubUrl: string;
  workspaceId: string;
}

export async function pairWithHub(
  hubUrlInput: string,
  opts: { name?: string; pollIntervalMs?: number; timeoutMs?: number } & PairCallbacks,
): Promise<PairResult> {
  const hubUrl = normalizeHubUrl(hubUrlInput);
  const name = opts.name ?? os.hostname();
  let start: Awaited<ReturnType<typeof postJson<RunnerPairStartResponse>>>;
  try {
    start = await postJson<RunnerPairStartResponse>(`${hubUrl}/api/runner/pair/start`, { name });
  } catch (e) {
    throw new Error(`não consegui falar com o hub em ${hubUrl}: ${(e as Error).message}`);
  }
  if (!start.data) throw new Error(`o hub recusou o pareamento (${start.status}): ${start.message ?? "sem detalhes"}`);
  const { pairCode, pollToken } = start.data;
  const approveUrl = start.data.approveUrl ?? `${hubUrl}/runner/parear?codigo=${encodeURIComponent(pairCode)}`;
  opts.onCode(pairCode, approveUrl);

  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    await sleep(opts.pollIntervalMs ?? 2000);
    let poll: Awaited<ReturnType<typeof postJson<RunnerPairPollResponse>>>;
    try {
      poll = await postJson<RunnerPairPollResponse>(`${hubUrl}/api/runner/pair/poll`, { pollToken });
    } catch {
      continue; // rede instável: tenta de novo
    }
    if (poll.status === 404 || poll.status === 410 || poll.data?.status === "expired") {
      throw new Error("o código de pareamento expirou. Rode `puxibot login` de novo.");
    }
    if (!poll.data) {
      if (poll.status >= 500) continue;
      throw new Error(`o hub respondeu ${poll.status} ao consultar o pareamento: ${poll.message ?? ""}`);
    }
    if (poll.data.status === "approved") {
      const finalHub = poll.data.hubUrl ? normalizeHubUrl(poll.data.hubUrl) : hubUrl;
      saveToken(poll.data.token);
      updateConfig({ hubUrl: finalHub, workspaceId: poll.data.workspaceId, runnerId: null, name });
      return { hubUrl: finalHub, workspaceId: poll.data.workspaceId };
    }
  }
  throw new Error("tempo esgotado esperando a aprovação. Rode `puxibot login` de novo.");
}

/** Alternativa sem pareamento: token de runner criado na interface. */
export async function loginWithToken(hubUrlInput: string, token: string, workspaceId: string, name?: string): Promise<PairResult> {
  const hubUrl = normalizeHubUrl(hubUrlInput);
  if (!/^tb_/.test(token)) throw new Error("token inválido: tokens de runner começam com tb_");
  if (!workspaceId) throw new Error("informe o workspace com --workspace <id>");
  // Verificação leve com GET /api/me (única rota HTTP aceita para token de runner).
  // Só falha se o hub disser claramente que o token não vale.
  let res: Response | null = null;
  try {
    res = await fetch(`${hubUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  } catch {
    res = null; // hub fora do ar: grava assim mesmo; `puxibot start` vai avisar.
  }
  if (res?.status === 401) throw new Error("o hub recusou este token (401)");
  if (res?.ok) {
    const me = (await res.json().catch(() => null)) as { workspaces?: { id: string }[] } | null;
    if (me?.workspaces && !me.workspaces.some((w) => w.id === workspaceId)) {
      throw new Error(`o dono deste token não é membro do workspace ${workspaceId}`);
    }
  }
  saveToken(token);
  updateConfig({ hubUrl, workspaceId, runnerId: null, ...(name ? { name } : {}) });
  return { hubUrl, workspaceId };
}
