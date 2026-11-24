/**
 * Ambiente do Worker. `Env` vem de `wrangler types` (worker-configuration.d.ts);
 * aqui só acrescentamos o que é opcional e por isso não está no wrangler.jsonc.
 */
export type AppEnv = Env & {
  /** Workers AI, só em produção (roteador de mensagens). */
  AI?: Ai;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Opcional: usuário do bot (sem @). Sem ele, o hub pergunta ao Telegram (getMe). */
  TELEGRAM_BOT_USERNAME?: string;
  /** WhatsApp (Cloud API da Meta), para conversar com um agente pelo WhatsApp. Sem os quatro, desligado. */
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  /** Segredo do app da Meta: assina cada webhook (cabeçalho X-Hub-Signature-256). */
  WHATSAPP_APP_SECRET?: string;
  /** Texto que você escolhe e informa à Meta ao registrar o webhook. */
  WHATSAPP_VERIFY_TOKEN?: string;
  /** Opcional: o número, como as pessoas devem ver na tela (ex.: +55 11 99999-0000). */
  WHATSAPP_DISPLAY_NUMBER?: string;
  /** "true" libera o cadastro sem convite. Padrão: só a primeira conta entra sem convite. */
  OPEN_SIGNUP?: string;
};

/** Cadastro sem convite liberado para qualquer pessoa (variável OPEN_SIGNUP). */
export function signupIsOpen(env: AppEnv): boolean {
  return /^(1|true|yes|sim|on)$/i.test((env.OPEN_SIGNUP ?? "").trim());
}

/** Tempo máximo de uma execução de agente (vai no JobAssignment e limita o token de job). */
export const JOB_TIMEOUT_MS = 30 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const PAIRING_TTL_MS = 10 * 60_000;
/** Quantas mensagens recentes vão como contexto no JobAssignment. */
export const JOB_CONTEXT_MESSAGES = 20;

export function publicUrl(env: AppEnv, fallbackOrigin?: string | null): string {
  const configured = (env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  return configured || (fallbackOrigin ?? "").replace(/\/+$/, "");
}
