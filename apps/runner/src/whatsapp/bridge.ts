/** Liga o WhatsApp vinculado neste computador à conexão com o hub, enquanto o runner está rodando. */
import type { HubToRunner, RunnerToHub } from "@puxibot/shared";
import type { RunnerConfig } from "../config.js";
import type { Logger } from "../log.js";
import { WhatsAppChannel, type WaLib } from "./channel.js";
import { baileysInstalled, loadBaileys, whatsappPaths } from "./lib.js";
import { fileSlotStore, type SlotStore } from "./store.js";

export interface WhatsAppBridge {
  channel: WhatsAppChannel;
  /** Texto que o hub mandou entregar à dona. */
  deliver(msg: Extract<HubToRunner, { type: "chat.send" }>): void;
  stop(): Promise<void>;
}

export interface BridgeDeps {
  lib?: WaLib;
  store?: SlotStore;
}

export async function startWhatsAppBridge(cfg: RunnerConfig, send: (m: RunnerToHub) => void, log: Logger, deps: BridgeDeps = {}): Promise<WhatsAppBridge | null> {
  const wa = cfg.whatsapp;
  if (!wa?.enabled) return null;
  if (!wa.agent || !wa.mode) {
    log.warn("whatsapp: configuração incompleta. Rode `puxibot whatsapp conectar` de novo.");
    return null;
  }
  if (!deps.lib && !baileysInstalled()) {
    log.warn("whatsapp: a biblioteca não está instalada neste computador. Rode `puxibot whatsapp conectar`.");
    return null;
  }
  const channel = new WhatsAppChannel({
    lib: deps.lib ?? (await loadBaileys()),
    store: deps.store ?? fileSlotStore(whatsappPaths.session()),
    mode: wa.mode,
    allowedNumber: wa.allowedNumber,
    pairing: false,
    logger: log,
    onText: (text) => send({ type: "chat.inbound", provider: "whatsapp", agent: wa.agent!, text: text.slice(0, 4000) }),
    onState: (state, detail) => {
      if (state === "connected") log.info(`whatsapp: conectado; mensagens suas vão para @${wa.agent}`);
      else if (state === "failed" || state === "logged_out" || (state === "stopped" && detail)) log.warn(`whatsapp: ${detail}`);
    },
  });
  await channel.start();
  return {
    channel,
    deliver: (msg) => {
      if (msg.provider !== "whatsapp" || typeof msg.text !== "string" || !msg.text.trim()) return;
      // Sem conexão a resposta fica só na conversa da interface; um envio duvidoso não é repetido.
      channel.sendText(msg.text).catch((e: unknown) => log.warn(`whatsapp: resposta não entregue (${e instanceof Error ? e.message : String(e)}). Ela está na conversa do Puxibot.`));
    },
    stop: () => channel.stop(),
  };
}
