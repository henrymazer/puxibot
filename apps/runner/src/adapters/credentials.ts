/**
 * Link do login da CLI dentro do estado do agente (`<estado>/.credentials.json -> login da pessoa`).
 *
 * O estado do agente tem escrita dentro do isolamento: o agente pode trocar o link por um
 * arquivo qualquer. Por isso o runner só copia esse arquivo de volta para o login da pessoa
 * quando:
 *   - o login foi montado COM ESCRITA neste job (o token precisava ser renovado; nesse caso a
 *     CLI pode ter trocado o link pelo token novo e perder a cópia quebraria o login);
 *   - é um arquivo comum (não link), lido sem seguir links;
 *   - é JSON válido no formato esperado da CLI.
 * Em qualquer outro caso o arquivo é descartado e o link refeito.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { safeMkdir, safeReadRegularFile, safeRemove, safeSymlink } from "../safefs.js";

export interface CredentialLinkOptions {
  /** Pasta de estado do agente (raiz para as operações seguras). */
  stateRoot: string;
  /** Caminho do link dentro do estado. */
  stateFile: string;
  /** Arquivo de login da pessoa. */
  userFile: string;
  /** Só true depois de um job em que o login estava montado com escrita. */
  copyBack: boolean;
  /** Formato esperado do arquivo. */
  validate: (json: unknown) => boolean;
  /** Opcional: só copia se o arquivo do estado for mais novo que o da pessoa. */
  newer?: (stateJson: unknown, userJson: unknown) => boolean;
}

export type CredentialSyncResult = "linked" | "copied" | "discarded";

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function syncCredentialLink(o: CredentialLinkOptions): Promise<CredentialSyncResult> {
  await fs.mkdir(o.stateRoot, { recursive: true, mode: 0o700 });
  await safeMkdir(o.stateRoot, path.dirname(o.stateFile));
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(o.stateFile);
  } catch {
    st = null;
  }
  let result: CredentialSyncResult = "linked";
  if (st?.isSymbolicLink() && readlinkSync(o.stateFile) === o.userFile) return result;
  if (st) {
    if (st.isFile() && o.copyBack) {
      const raw = await safeReadRegularFile(o.stateRoot, o.stateFile);
      let json: unknown = null;
      try {
        json = raw ? JSON.parse(raw.toString("utf8")) : null;
      } catch {
        json = null;
      }
      const ok = json !== null && o.validate(json) && (!o.newer || o.newer(json, existsSync(o.userFile) ? readJson(o.userFile) : null));
      if (ok) {
        const tmp = `${o.userFile}.puxibot.${process.pid}.tmp`;
        await fs.writeFile(tmp, raw!, { mode: 0o600 });
        await fs.chmod(tmp, 0o600);
        await fs.rename(tmp, o.userFile);
        result = "copied";
      } else result = "discarded";
    } else if (!st.isSymbolicLink()) result = "discarded";
    await safeRemove(o.stateRoot, o.stateFile);
  }
  if (existsSync(o.userFile)) await safeSymlink(o.stateRoot, o.stateFile, o.userFile);
  return result;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** `.credentials.json` do Claude Code. */
export function isClaudeCredentials(j: unknown): boolean {
  if (!isObj(j) || !isObj(j.claudeAiOauth)) return false;
  const o = j.claudeAiOauth;
  return typeof o.accessToken === "string" && typeof o.refreshToken === "string" && typeof o.expiresAt === "number";
}

/** `auth.json` do Codex. [SUPOSIÇÃO: formato lido da documentação, não testado.] */
export function isCodexAuth(j: unknown): boolean {
  if (!isObj(j)) return false;
  if (typeof j.OPENAI_API_KEY === "string" && j.OPENAI_API_KEY) return true;
  return isObj(j.tokens) && typeof j.tokens.access_token === "string" && typeof j.tokens.refresh_token === "string";
}

/** `oauth_creds.json` do Gemini CLI. [SUPOSIÇÃO: não testado.] */
export function isGeminiOauth(j: unknown): boolean {
  return isObj(j) && (typeof j.access_token === "string" || typeof j.refresh_token === "string");
}

/** `google_accounts.json` do Gemini CLI. [SUPOSIÇÃO: não testado.] */
export function isGeminiAccounts(j: unknown): boolean {
  return isObj(j) && "active" in j && (j.active === null || typeof j.active === "string");
}
