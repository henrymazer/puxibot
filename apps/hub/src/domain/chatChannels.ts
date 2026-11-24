/**
 * Conversa com um agente por Telegram ou WhatsApp: a mensagem que a pessoa manda vira uma mensagem dela na
 * DM com o agente, e a resposta do agente volta pelo mesmo canal. É a mesma conversa (memória e tarefas)
 * da interface. Só a conta que a pessoa vinculou fala com o agente; ninguém mais.
 *
 * Como no Nod (n8n-io/nod, docs/use/channels): o canal externo carrega só a conversa. Aprovações, logins e
 * conexões continuam na interface, e segredos do canal nunca aparecem em mensagens de erro.
 *
 * WhatsApp usa a API oficial (Cloud API, com webhook assinado). [SUPOSIÇÃO: escrito a partir da
 * documentação da Meta; não foi testado com uma conta real.]
 */
import { CHAT_REPLY_RUNNER_PREFIX, type ChatLinkDTO } from "@puxibot/shared";
import { publicUrl, type AppEnv } from "../env";
import { bytesToHex, randomCode, timingSafeEqual } from "../lib/crypto";
import { all, first, newId, run } from "../lib/db";
import { hit } from "../lib/rateLimit";
import { canTalkTo, getAgentRow } from "./agents";
import type { AgentRow } from "./rows";
import { findOrCreateDm } from "./channels";
import { workerCtx, type HubCtx } from "./context";
import { requestAgentWork } from "./jobs";
import { getMember } from "./members";
import { insertMessage } from "./messages";
import type { JobRow } from "./rows";
import { botUsername, telegramApi, telegramConfigured } from "./telegram";

export type ChatProvider = "telegram" | "whatsapp";

export interface ChatLinkRow {
  id: string;
  user_id: string;
  provider: ChatProvider;
  external_id: string | null;
  link_code: string;
  workspace_id: string;
  agent_id: string;
  created_at: number;
}

const MAX_INBOUND_CHARS = 4000;
const INBOUND_PER_HOUR = 60;
export const WHATSAPP_GRAPH_VERSION = "v21.0";

export function whatsappConfigured(env: AppEnv): boolean {
  return !!(env.WHATSAPP_ACCESS_TOKEN?.trim() && env.WHATSAPP_PHONE_NUMBER_ID?.trim() && env.WHATSAPP_APP_SECRET?.trim() && env.WHATSAPP_VERIFY_TOKEN?.trim());
}

export function providerConfigured(env: AppEnv, provider: ChatProvider): boolean {
  return provider === "telegram" ? telegramConfigured(env) && !!env.TELEGRAM_WEBHOOK_SECRET?.trim() : whatsappConfigured(env);
}

async function providerAddress(env: AppEnv, provider: ChatProvider): Promise<string | null> {
  if (provider === "telegram") return (await botUsername(env)) || null;
  return env.WHATSAPP_DISPLAY_NUMBER?.trim() || null;
}

export async function chatLinkDTO(env: AppEnv, provider: ChatProvider, row: ChatLinkRow | null): Promise<ChatLinkDTO> {
  const available = providerConfigured(env, provider);
  return {
    provider,
    available,
    linked: !!row?.external_id,
    linkCode: row && !row.external_id ? row.link_code : null,
    address: available ? await providerAddress(env, provider) : null,
    workspaceId: row?.workspace_id ?? null,
    agentId: row?.agent_id ?? null,
  };
}

export async function getChatLink(db: D1Database, userId: string, provider: ChatProvider): Promise<ChatLinkRow | null> {
  return first<ChatLinkRow>(db, "SELECT * FROM chat_links WHERE user_id = ? AND provider = ?", userId, provider);
}

/** Cria (ou refaz) o vínculo: gera um código novo e esquece a conta externa anterior. */
export async function createChatLink(db: D1Database, input: { userId: string; provider: ChatProvider; workspaceId: string; agentId: string }): Promise<ChatLinkRow> {
  const row: ChatLinkRow = {
    id: newId(),
    user_id: input.userId,
    provider: input.provider,
    external_id: null,
    link_code: randomCode(2, 4).replace(/-/g, ""),
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    created_at: Date.now(),
  };
  await db.batch([
    db.prepare("DELETE FROM chat_links WHERE user_id = ? AND provider = ?").bind(input.userId, input.provider),
    db
      .prepare("INSERT INTO chat_links (id, user_id, provider, external_id, link_code, workspace_id, agent_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)")
      .bind(row.id, row.user_id, row.provider, row.link_code, row.workspace_id, row.agent_id, row.created_at),
  ]);
  return row;
}

// ---------- Envio ----------
/** Parte um texto longo em mensagens, quebrando em parágrafo ou linha quando dá. */
export function splitMessage(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Erro de envio sem o token do canal (que vai na URL do Telegram e no cabeçalho do WhatsApp). */
function safeSendError(env: AppEnv, err: unknown): string {
  let msg = String(err instanceof Error ? err.message : err);
  for (const secret of [env.TELEGRAM_BOT_TOKEN, env.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_APP_SECRET]) {
    if (secret?.trim()) msg = msg.split(secret.trim()).join("[oculto]");
  }
  return msg.slice(0, 300);
}

export async function sendChatText(env: AppEnv, provider: ChatProvider, to: string, text: string): Promise<boolean> {
  if (!providerConfigured(env, provider) || !text.trim()) return false;
  try {
    for (const part of splitMessage(text, provider === "telegram" ? 4000 : 3800).slice(0, 8)) {
      let res: Response;
      if (provider === "telegram") {
        res = await telegramApi(env, "sendMessage", { chat_id: to, text: part, disable_web_page_preview: true });
      } else {
        res = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID!.trim())}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN!.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: part } }),
          signal: AbortSignal.timeout(10_000),
        });
      }
      const ok = res.ok;
      await res.body?.cancel();
      if (!ok) {
        console.warn(JSON.stringify({ msg: "chat send refused", provider, status: res.status }));
        return false;
      }
    }
    return true;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "chat send failed", provider, error: safeSendError(env, err) }));
    return false;
  }
}

/** A resposta do agente volta pelo canal por onde o pedido chegou. Chamado pelo WorkspaceHub ao fim do trabalho. */
export async function deliverChatReply(env: AppEnv, job: Pick<JobRow, "reply_via" | "reply_to">, text: string): Promise<void> {
  if (!job.reply_via || !job.reply_to || !text.trim()) return;
  await sendChatText(env, job.reply_via, job.reply_to, text);
}

// ---------- Recebimento ----------
const HELP: Record<ChatProvider, string> = {
  telegram: "Para conversar com um agente por aqui, abra o Puxibot em Configurações › Canais de conversa, gere um código e envie /start <código>.",
  whatsapp: "Para conversar com um agente por aqui, abra o Puxibot em Configurações › Canais de conversa, gere um código e envie: vincular <código>.",
};

/** Código de vínculo numa mensagem: "/start CODE" (Telegram) ou "vincular CODE" (WhatsApp). */
export function linkCodeFrom(text: string): string | null {
  const m = /^(?:\/start(?:@\w+)?|vincular|conectar)\s+([A-Za-z0-9-]{4,40})$/i.exec(text.trim());
  return m ? m[1]!.toUpperCase().replace(/-/g, "") : null;
}

/**
 * Trata uma mensagem recebida. Devolve o texto a responder na hora (vínculo, ajuda, recusa) ou `null`
 * quando a mensagem virou um pedido ao agente (a resposta vem depois, pelo trabalho).
 */
export async function handleInbound(env: AppEnv, provider: ChatProvider, externalId: string, rawText: string): Promise<string | null> {
  const db = env.DB;
  const text = rawText.trim();
  if (!text) return null;
  const code = linkCodeFrom(text);
  if (code) {
    // Uma conta externa fala com um agente só: vincular de novo solta o vínculo antigo dela.
    const target = await first<ChatLinkRow>(db, "SELECT * FROM chat_links WHERE provider = ? AND link_code = ? AND external_id IS NULL", provider, code);
    if (!target) return provider === "telegram" ? null : "Código não encontrado. Gere um novo em Configurações › Canais de conversa.";
    await db.batch([
      db.prepare("DELETE FROM chat_links WHERE provider = ? AND external_id = ? AND id <> ?").bind(provider, externalId, target.id),
      db.prepare("UPDATE chat_links SET external_id = ? WHERE id = ? AND external_id IS NULL").bind(externalId, target.id),
    ]);
    const agent = await getAgentRow(db, target.workspace_id, target.agent_id);
    return `Pronto! Agora você conversa com ${agent?.name ?? "o agente"} por aqui. Aprovações e conexões continuam no Puxibot. Para parar, envie /parar.`;
  }
  const link = await first<ChatLinkRow>(db, "SELECT * FROM chat_links WHERE provider = ? AND external_id = ?", provider, externalId);
  if (!link) return HELP[provider];
  if (/^\/(parar|stop)\b/i.test(text)) {
    await run(db, "DELETE FROM chat_links WHERE id = ?", link.id);
    return "Conversa desligada. Para voltar, gere um novo código no Puxibot.";
  }
  if (text.startsWith("/")) return "Comando desconhecido. Escreva o que você precisa, ou envie /parar para desligar a conversa.";
  if ((await hit(db, `chat:${link.id}`, 60 * 60_000)).count > INBOUND_PER_HOUR) return "Muitas mensagens em pouco tempo. Tente de novo daqui a pouco.";

  const [member, agent] = await Promise.all([getMember(db, link.workspace_id, link.user_id), getAgentRow(db, link.workspace_id, link.agent_id)]);
  if (!member || !agent || !(await canTalkTo(db, agent, link.user_id))) {
    await run(db, "DELETE FROM chat_links WHERE id = ?", link.id);
    return "Este vínculo não vale mais (o agente ou o seu acesso mudou). Gere um novo código no Puxibot.";
  }
  return startChatWork(workerCtx(env, link.workspace_id), { userId: link.user_id, agent, provider, replyTo: externalId, text });
}

/** A mensagem vira uma mensagem da pessoa na DM com o agente e abre o trabalho, com a resposta marcada para voltar pelo canal. */
async function startChatWork(ctx: HubCtx, input: { userId: string; agent: AgentRow; provider: ChatProvider; replyTo: string; text: string }): Promise<string | null> {
  const db = ctx.env.DB;
  const { agent, userId } = input;
  const { channel } = await findOrCreateDm(db, ctx.wsId, { type: "user", id: userId }, { type: "agent", id: agent.id }, userId);
  const body = input.text.slice(0, MAX_INBOUND_CHARS);
  const message = await insertMessage(ctx, { channel, author: { type: "user", id: userId }, body });
  const job = await requestAgentWork(ctx, { agent, userId, channel, prompt: body, triggerMessageId: message.id, threadRootId: null, replyVia: input.provider, replyTo: input.replyTo });
  if (!job) {
    const base = publicUrl(ctx.env);
    return `${agent.name} não pode responder agora (pausado, sem orçamento ou sem acesso). ${base ? `Veja em ${base}` : "Veja no Puxibot."}`;
  }
  return null;
}

/**
 * WhatsApp ligado por QR code no computador da pessoa (como no Nod): o runner dela repassa o que ela
 * escreveu. A identidade vem da conexão do runner (o token dele), não de um número; o runner só repassa
 * mensagens da própria dona. O agente é escolhido na configuração do runner e conferido aqui.
 */
export async function handleRunnerInbound(ctx: HubCtx, userId: string, agentHandle: string, rawText: string): Promise<string | null> {
  const db = ctx.env.DB;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return null;
  const handle = String(agentHandle ?? "").trim().replace(/^@/, "").toLowerCase().slice(0, 64);
  const [agent] = await all<AgentRow>(db, "SELECT * FROM agents WHERE workspace_id = ? AND handle = ?", ctx.wsId, handle);
  if (!agent) return `Não achei o agente @${handle || "?"} neste workspace. Confira com \`puxibot whatsapp status\` e conecte de novo.`;
  if (agent.system_kind === "builder") return "O agente criador conversa só pela interface.";
  if (!(await getMember(db, ctx.wsId, userId)) || !(await canTalkTo(db, agent, userId))) return `Você não tem permissão para falar com ${agent.name}.`;
  if ((await hit(db, `chat:runner:${userId}`, 60 * 60_000)).count > INBOUND_PER_HOUR) return "Muitas mensagens em pouco tempo. Tente de novo daqui a pouco.";
  return startChatWork(ctx, { userId, agent, provider: "whatsapp", replyTo: `${CHAT_REPLY_RUNNER_PREFIX}${userId}`, text });
}

// ---------- WhatsApp: assinatura do webhook ----------
/** Confere `X-Hub-Signature-256: sha256=<hmac do corpo com o segredo do app>`. */
export async function verifyWhatsAppSignature(appSecret: string, rawBody: string, header: string | undefined): Promise<boolean> {
  const given = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "")?.[1];
  if (!given) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  return timingSafeEqual(bytesToHex(sig), given.toLowerCase());
}

export interface WhatsAppWebhook {
  entry?: { changes?: { value?: { metadata?: { phone_number_id?: string }; messages?: { from?: string; type?: string; text?: { body?: string } }[] } }[] }[];
}

/** Mensagens de texto de um webhook do WhatsApp, só as destinadas ao número configurado. */
export function whatsappTexts(payload: WhatsAppWebhook, phoneNumberId: string): { from: string; text: string }[] {
  const out: { from: string; text: string }[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value || value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const m of value.messages ?? []) {
        if (m.type === "text" && m.from && /^\d{6,20}$/.test(m.from) && m.text?.body) out.push({ from: m.from, text: m.text.body });
      }
    }
  }
  return out;
}
