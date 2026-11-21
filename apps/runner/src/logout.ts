/**
 * `puxibot logout`: remove o próprio registro no hub (`DELETE /api/workspaces/:ws/runners/:id`,
 * aceito com o token de runner para o próprio id) e apaga o token local. Um
 * `puxibot start` em execução recebe o fechamento 4001 do hub e para sozinho.
 */
import { deleteToken, loadConfig, loadToken, saveConfig } from "./config.js";

export interface LogoutResult {
  /** true: removido no hub (ou já não existia); false: o hub recusou; null: não deu para falar com o hub. */
  removed: boolean | null;
  message: string;
}

export async function logout(fetchImpl: typeof fetch = fetch): Promise<LogoutResult> {
  const cfg = loadConfig();
  const token = loadToken();
  let removed: boolean | null = null;
  let detail = "";
  if (token && cfg.hubUrl && cfg.workspaceId && cfg.runnerId) {
    const url = `${cfg.hubUrl.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(cfg.workspaceId)}/runners/${encodeURIComponent(cfg.runnerId)}`;
    try {
      const res = await fetchImpl(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 204 || res.status === 200 || res.status === 404) removed = true;
      else {
        removed = false;
        try {
          detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
        } catch {
          detail = `HTTP ${res.status}`;
        }
      }
    } catch (e) {
      removed = null;
      detail = e instanceof Error ? e.message : String(e);
    }
  } else if (token && cfg.hubUrl) {
    detail = "este runner ainda não tinha se registrado no hub (nunca rodou `puxibot start`)";
  }
  await deleteToken();
  saveConfig({ ...cfg, hubUrl: undefined, workspaceId: undefined, runnerId: null });

  const revoke = "O token de runner continua existindo no hub até ser revogado em Configurações › Tokens (esta máquina não o guarda mais).";
  let message: string;
  if (removed === true) message = `Runner removido do hub e token local apagado. ${revoke}`;
  else if (removed === false) message = `O hub recusou remover o runner (${detail}). O token local foi apagado; remova o runner pela interface (Configurações › Computadores). ${revoke}`;
  else if (detail && token) message = `Não foi possível remover o runner no hub (${detail}). O token local foi apagado; remova o runner pela interface (Configurações › Computadores). ${revoke}`;
  else message = token ? "Token local apagado." : "Este runner já não estava conectado a nenhum hub.";
  return { removed, message };
}
