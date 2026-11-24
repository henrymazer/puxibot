/** `puxibot whatsapp conectar | desconectar | status`. */
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline/promises";
import qrcode from "qrcode-terminal";
import { loadConfig, paths, updateConfig } from "../config.js";
import { silentLogger } from "../log.js";
import { validPhone, WhatsAppChannel, type WaMode, type WaState } from "./channel.js";
import { BAILEYS_PACKAGE, BAILEYS_VERSION, baileysInstalled, installBaileys, loadBaileys, whatsappPaths } from "./lib.js";
import { fileSlotStore } from "./store.js";

export const RISK_NOTICE = `Antes de ligar, leia:

  - Isto usa o Baileys, um cliente NÃO oficial do WhatsApp. Há um risco pequeno de o WhatsApp
    restringir ou banir a conta, e uma atualização dele pode quebrar a conexão por um tempo.
  - Serve para uso pessoal: você conversando com o seu agente, com poucas mensagens. O agente só
    escreve para você. Para atender clientes ou enviar mensagens em volume, use a API oficial
    (configurada no hub pelo admin).
  - Grupos, status e conversas anteriores são ignorados. Só mensagens suas chegam ao agente.
  - As chaves do aparelho ficam neste computador, em ~/.puxibot/whatsapp (escondida dos agentes).
  - Só funciona com este computador ligado e o runner rodando.
  - Confira os termos de uso do WhatsApp antes de continuar.`;

function runnerRunning(): boolean {
  try {
    if (!existsSync(paths.pid())) return false;
    const pid = Number(readFileSync(paths.pid(), "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mask(n: string | undefined): string {
  return n ? `${n.slice(0, 4)}…${n.slice(-2)}` : "?";
}

async function hasKeys(): Promise<boolean> {
  return (await fileSlotStore(whatsappPaths.session()).get("creds")) !== undefined;
}

export interface ConnectOptions {
  agente: string;
  numeroSeparado?: boolean;
  meuNumero?: string;
  aceitoORisco?: boolean;
}

export async function whatsappConnect(o: ConnectOptions, out: (line: string) => void = console.log): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.hubUrl || !cfg.workspaceId) throw new Error("este computador ainda não está ligado a um hub. Rode `puxibot login <url-do-hub>` primeiro.");
  const agent = o.agente.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(agent)) throw new Error("informe o agente pelo handle, ex.: --agente assistente");
  const mode: WaMode = o.numeroSeparado ? "bot" : "self-chat";
  const allowed = o.meuNumero?.replace(/[^\d]/g, "");
  if (mode === "bot" && !validPhone(allowed)) throw new Error("com --numero-separado, informe --meu-numero com o seu número pessoal (código do país e DDD, só dígitos; ex.: 5511999990000)");
  // Chaves guardadas com o WhatsApp já ligado: é outro vínculo. Chaves sem a configuração: um vínculo que
  // não chegou ao fim (o comando foi interrompido depois de ler o QR); ele é retomado, sem QR novo.
  const resuming = await hasKeys();
  if (resuming && cfg.whatsapp?.enabled) throw new Error("já existe um WhatsApp vinculado neste computador. Rode `puxibot whatsapp desconectar` antes de vincular outro.");

  out(RISK_NOTICE);
  out("");
  if (!o.aceitoORisco) {
    if (!process.stdin.isTTY) throw new Error("para continuar sem terminal interativo, passe --aceito-o-risco");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Digite "aceito" para continuar: ')).trim().toLowerCase();
    rl.close();
    if (answer !== "aceito") throw new Error("vínculo cancelado.");
  }

  if (!baileysInstalled()) {
    out(`Instalando a biblioteca do WhatsApp (${BAILEYS_PACKAGE}@${BAILEYS_VERSION}) em ${whatsappPaths.lib()} ...`);
    await installBaileys();
  }
  const lib = await loadBaileys();
  const store = fileSlotStore(whatsappPaths.session());
  if (resuming) out("Há um vínculo iniciado e não concluído neste computador. Retomando...");

  const attempt = async () => {
    let finish: (v: WaState) => void = () => {};
    const done = new Promise<WaState>((resolve) => (finish = resolve));
    let detail = "";
    let announced = false;
    let giveUp = "";
    const channel = new WhatsAppChannel({
      lib,
      store,
      mode,
      allowedNumber: allowed,
      pairing: true,
      logger: silentLogger,
      onText: () => {},
      onQr: (qr) => {
        out("");
        qrcode.generate(qr, { small: true }, (art) => out(art));
        out("No celular: WhatsApp › Configurações › Dispositivos conectados › Conectar dispositivo, e leia o código acima.");
        out(mode === "bot" ? "Leia com o celular do número SEPARADO (o do agente), não com o seu." : "Leia com o celular do seu próprio número.");
        out("O código vale 1 minuto; um novo aparece sozinho. Ctrl+C cancela.");
      },
      onState: (state, d) => {
        detail = d;
        if (state === "connecting" && !announced) {
          announced = true;
          out("Conectando ao WhatsApp...");
        }
        if (state === "connected" || state === "failed" || state === "expired" || state === "logged_out") finish(state);
      },
      onDisconnect: (code, message, attempt) => {
        // 515 é o pedido normal de reconexão logo depois de ler o QR.
        if (code === 515) return;
        out(`A conexão caiu (código ${code ?? "?"}${message ? `: ${message}` : ""}). Tentando de novo...`);
        if (attempt >= 6) {
          giveUp = `O WhatsApp fechou a conexão ${attempt} vezes seguidas (código ${code ?? "?"}${message ? `: ${message}` : ""}). Rode \`puxibot whatsapp desconectar\`, remova o aparelho "Puxibot" em Dispositivos conectados no celular e vincule de novo.`;
          finish("failed");
        }
      },
    });
    const cancel = () => {
      // Vínculo pela metade não fica guardado.
      void channel
        .stop()
        .then(() => (channel.linked() ? undefined : store.clear()))
        .finally(() => process.exit(130));
    };
    process.once("SIGINT", cancel);
    // Mantém o processo vivo enquanto o vínculo não termina, mesmo nos instantes sem conexão aberta.
    const alive = setInterval(() => {}, 1000);
    await channel.start();
    const state = await done;
    clearInterval(alive);
    process.removeListener("SIGINT", cancel);
    return { state, channel, detail, giveUp };
  };

  let result = await attempt();
  if (resuming && result.state === "logged_out") {
    // O WhatsApp recusou o vínculo que ficou pela metade: apaga o que sobrou e começa um novo, com QR.
    await result.channel.stop();
    await store.clear();
    out("O vínculo iniciado antes não vale mais. Gerando um QR code novo...");
    out('Se aparecer um aparelho "Puxibot" antigo em Dispositivos conectados no celular, remova-o.');
    result = await attempt();
  }
  const { state, channel } = result;
  if (state !== "connected") {
    await channel.stop();
    if (state === "logged_out" || state === "expired") await store.clear();
    throw new Error(result.giveUp || result.detail || "não foi possível vincular o WhatsApp.");
  }
  const own = channel.ownNumber();
  // Logo depois do vínculo o WhatsApp ainda entrega chaves; espera um pouco antes de fechar.
  await new Promise((r) => setTimeout(r, 5000));
  await channel.stop();
  updateConfig({ whatsapp: { enabled: true, mode, agent, ...(mode === "bot" ? { allowedNumber: allowed } : {}) } });

  out("");
  out(`Pronto: o número ${mask(own)} está vinculado e fala com @${agent}.`);
  out(mode === "bot" ? `Escreva para esse número a partir do seu (${mask(allowed)}).` : 'Abra a conversa "Mensagem para você mesmo" no WhatsApp e escreva por lá.');
  out(runnerRunning() ? "Reinicie o runner para ligar o WhatsApp: pare o `puxibot start` (Ctrl+C) e rode de novo." : "Agora rode `puxibot start`.");
}

export async function whatsappDisconnect(out: (line: string) => void = console.log): Promise<void> {
  if (runnerRunning()) throw new Error("pare o runner antes (Ctrl+C no `puxibot start`) e rode este comando de novo: os dois não podem usar o mesmo vínculo ao mesmo tempo.");
  const cfg = loadConfig();
  const store = fileSlotStore(whatsappPaths.session());
  let told = false;
  if (cfg.whatsapp?.mode && (await hasKeys()) && baileysInstalled()) {
    // Avisa o WhatsApp, para o aparelho sumir de "Dispositivos conectados".
    let ready: () => void = () => {};
    const settled = new Promise<void>((resolve) => (ready = resolve));
    const channel = new WhatsAppChannel({
      lib: await loadBaileys(),
      store,
      mode: cfg.whatsapp.mode,
      allowedNumber: cfg.whatsapp.allowedNumber,
      pairing: false,
      logger: silentLogger,
      onText: () => {},
      onState: (state) => {
        if (state !== "connecting") ready();
      },
    });
    await channel.start();
    await Promise.race([settled, new Promise<void>((r) => setTimeout(r, 20_000))]);
    told = channel.state === "connected";
    await channel.unlink().catch(() => {});
  }
  await store.clear();
  updateConfig({ whatsapp: { ...(cfg.whatsapp ?? {}), enabled: false } });
  out("WhatsApp desvinculado deste computador; as chaves foram apagadas.");
  if (!told) out("Não consegui avisar o WhatsApp. No celular, remova o aparelho \"Puxibot\" em Configurações › Dispositivos conectados.");
}

export async function whatsappStatus(): Promise<string> {
  const wa = loadConfig().whatsapp;
  const keys = await hasKeys();
  if (!wa?.enabled || !keys) return "WhatsApp: não vinculado neste computador. Para ligar: puxibot whatsapp conectar --agente <handle>";
  return [
    `WhatsApp: vinculado (${wa.mode === "bot" ? `número separado; aceita mensagens de ${mask(wa.allowedNumber)}` : "seu próprio número, pela conversa com você mesmo"})`,
    `Agente: @${wa.agent}`,
    `Biblioteca: ${baileysInstalled() ? `${BAILEYS_PACKAGE}@${BAILEYS_VERSION}` : "não instalada (rode `puxibot whatsapp conectar`)"}`,
    `Runner: ${runnerRunning() ? "rodando" : "parado (o WhatsApp só responde com o runner rodando)"}`,
  ].join("\n");
}
