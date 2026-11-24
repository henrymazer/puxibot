#!/usr/bin/env node
/** CLI `puxibot`: login, start, status, logout, doctor, service, mcp e mcp-proxy. */
import { Command, InvalidArgumentError } from "commander";
import { ISOLATION_MODES, type IsolationMode } from "@puxibot/shared";
import { loadConfig, saveConfig } from "./config.js";
import { doctor, formatDoctor, status } from "./doctor.js";
import { createLogger } from "./log.js";
import { loginWithToken, pairWithHub } from "./pairing.js";
import { logout } from "./logout.js";
import { serviceFiles } from "./service.js";
import { RUNNER_VERSION } from "./version.js";

const program = new Command();
program
  .name("puxibot")
  .description("Runner do Puxibot: executa os agentes do seu time na sua máquina, com a CLI de IA que você já usa.")
  .version(RUNNER_VERSION, "-v, --version", "mostra a versão")
  .helpOption("-h, --help", "mostra a ajuda")
  .addHelpCommand("help [comando]", "mostra a ajuda de um comando")
  .addHelpText(
    "after",
    `
Isolamento (--isolation):
  sandbox    padrão. Linux/WSL2 com bubblewrap (macOS: Seatbelt, não testado). O agente
             só escreve na própria pasta de trabalho. A pasta pessoal, /home, /root, /mnt
             (no WSL, o disco do Windows), /media e discos externos ficam ocultos; as pastas
             do sistema (/usr, /etc, /bin, /lib*, /opt) ficam somente leitura.
  container  um container Docker/Podman por job, só com a pasta do agente montada.
  none       sem isolamento (só para testes).

Configuração (~/.puxibot/config.json, ou $PUXIBOT_HOME/config.json):
  "sandbox": {
    "extraReadOnly": ["~/projetos/site"],   pastas liberadas somente leitura
    "extraWritable": ["~/projetos/site/out"], pastas liberadas com escrita
    "hidePaths": ["~/projetos/site/.env"],  esconder algo dentro de uma pasta liberada
    "network": false                         corta a rede no sandbox (Linux)
  }
  O token do runner (~/.puxibot) e pastas de chaves (~/.ssh, ~/.aws, ~/.gnupg...)
  continuam escondidos mesmo dentro de uma pasta liberada.`,
  );

program
  .command("login")
  .description("conecta este runner a um hub (pareamento pela interface ou token)")
  .argument("<hubUrl>", "endereço do hub, ex.: https://puxibot.seutime.workers.dev")
  .option("--token <token>", "token de runner (tb_...) criado na interface, em vez do pareamento")
  .option("--workspace <id>", "id do workspace (obrigatório com --token)")
  .option("--name <nome>", "nome deste runner (padrão: nome da máquina)")
  .option("--start", "depois de conectar, já fica executando (o mesmo que rodar `puxibot start` em seguida)")
  .action(async (hubUrl: string, o: { token?: string; workspace?: string; name?: string; start?: boolean }) => {
    const next = async (msg: string) => {
      if (!o.start) return console.log(`${msg} Agora rode \`puxibot start\`.`);
      console.log(`${msg} Ligando o runner (Ctrl+C encerra; para ligar de novo depois, rode \`puxibot start\`).`);
      const { startRunner } = await import("./runner.js");
      await startRunner({ logger: createLogger("puxibot") });
    };
    if (o.token) {
      const r = await loginWithToken(hubUrl, o.token, o.workspace ?? "", o.name);
      await next(`Pronto: runner ligado ao workspace ${r.workspaceId} em ${r.hubUrl}.`);
      return;
    }
    const r = await pairWithHub(hubUrl, {
      name: o.name,
      onCode: (code, url) => {
        console.log("");
        console.log(`  Código de pareamento: ${code}`);
        console.log("");
        console.log(`  Abra ${url}`);
        console.log("  (ou vá em Configurações › Computadores na interface) e aprove este código.");
        console.log("");
        console.log("Esperando a aprovação... (Ctrl+C para cancelar)");
      },
    });
    await next(`Aprovado! Runner ligado ao workspace ${r.workspaceId} em ${r.hubUrl}.`);
  });

function parseIsolation(v: string): IsolationMode {
  if (!(ISOLATION_MODES as readonly string[]).includes(v)) throw new InvalidArgumentError(`use ${ISOLATION_MODES.join(", ")}`);
  return v as IsolationMode;
}
function parseCapacity(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new InvalidArgumentError("use um número inteiro de 1 a 32");
  return n;
}

program
  .command("start")
  .description("conecta ao hub e fica executando os jobs dos agentes")
  .option("--isolation <modo>", "sandbox (padrão), container ou none", parseIsolation)
  .option("--capacity <n>", "quantos jobs ao mesmo tempo (padrão 1)", parseCapacity)
  .option("--name <nome>", "nome deste runner na interface")
  .option("--save", "grava estas opções como padrão")
  .action(async (o: { isolation?: IsolationMode; capacity?: number; name?: string; save?: boolean }) => {
    if (o.save) {
      const cfg = loadConfig();
      saveConfig({ ...cfg, ...(o.isolation ? { isolation: o.isolation } : {}), ...(o.capacity ? { capacity: o.capacity } : {}), ...(o.name ? { name: o.name } : {}) });
    }
    const { startRunner } = await import("./runner.js");
    await startRunner({ isolation: o.isolation, capacity: o.capacity, name: o.name, logger: createLogger("puxibot") });
  });

program
  .command("status")
  .description("mostra a conexão configurada e se o runner está rodando")
  .action(() => {
    console.log(status());
  });

program
  .command("logout")
  .description("remove este runner do hub e apaga o token local")
  .action(async () => {
    const r = await logout();
    console.log(r.message);
  });

program
  .command("doctor")
  .description("verifica CLIs de IA, logins e isolamento disponíveis")
  .option("--json", "saída em JSON")
  .action(async (o: { json?: boolean }) => {
    const r = await doctor();
    console.log(o.json ? JSON.stringify(r, null, 2) : formatDoctor(r));
  });

program
  .command("service")
  .description("mostra (sem instalar) uma unidade systemd de usuário e um plist do launchd para manter o runner ligado")
  .option("--systemd", "só a unidade systemd")
  .option("--launchd", "só o plist do launchd (macOS)")
  .action((o: { systemd?: boolean; launchd?: boolean }) => {
    const f = serviceFiles();
    const both = !o.systemd && !o.launchd;
    if (o.systemd || both) {
      console.log(`# Linux/WSL2 (systemd de usuário). Salve em ${f.systemdPath} e rode:`);
      console.log("#   systemctl --user daemon-reload && systemctl --user enable --now puxibot-runner");
      console.log("#   (para continuar ligado sem sessão aberta: loginctl enable-linger $USER)");
      console.log(f.systemd);
    }
    if (o.launchd || both) {
      if (both) console.log("");
      console.log(`<!-- macOS (launchd, não testado). Salve em ${f.launchdPath} e rode: launchctl load -w ${f.launchdPath} -->`);
      console.log(f.launchd);
    }
  });

const whatsapp = program.command("whatsapp").description("conversa com um agente seu pelo WhatsApp, vinculado por QR code neste computador (uso pessoal)");
whatsapp
  .command("conectar")
  .description("mostra o QR code para vincular o WhatsApp a este computador")
  .requiredOption("--agente <handle>", "agente que vai responder (o handle, sem @)")
  .option("--numero-separado", "vincula um número só do agente, em vez do seu próprio")
  .option("--meu-numero <numero>", "com --numero-separado: seu número pessoal, o único que pode escrever (ex.: 5511999990000)")
  .option("--aceito-o-risco", "confirma o aviso sem perguntar (cliente não oficial do WhatsApp)")
  .action(async (o: { agente: string; numeroSeparado?: boolean; meuNumero?: string; aceitoORisco?: boolean }) => {
    const { whatsappConnect } = await import("./whatsapp/command.js");
    await whatsappConnect(o);
    process.exit(0);
  });
whatsapp
  .command("desconectar")
  .description("desvincula o WhatsApp e apaga as chaves deste computador")
  .action(async () => {
    const { whatsappDisconnect } = await import("./whatsapp/command.js");
    await whatsappDisconnect();
    process.exit(0);
  });
whatsapp
  .command("status")
  .description("mostra se o WhatsApp está vinculado e com qual agente")
  .action(async () => {
    const { whatsappStatus } = await import("./whatsapp/command.js");
    console.log(await whatsappStatus());
  });

program
  .command("mcp")
  .description("servidor MCP das ferramentas do Puxibot (iniciado pela CLI de IA durante um job)")
  .action(async () => {
    const { runMcpServer } = await import("./mcp/server.js");
    await runMcpServer();
  });

program
  .command("mcp-proxy", { hidden: true })
  .description("intermediário entre a CLI de IA e um conector: checa a permissão de cada ação no hub (iniciado durante um job)")
  .requiredOption("--config-env <nome>", "variável de ambiente com a configuração do conector")
  .action(async (o: { configEnv: string }) => {
    const { runConnectorGateway } = await import("./mcp/gateway.js");
    await runConnectorGateway(o.configEnv);
  });

program
  .command("mcp-exec", { hidden: true })
  .description("inicia um conector stdio com as variáveis dele (iniciado pela CLI de IA durante um job)")
  .requiredOption("--config-env <nome>", "variável de ambiente com a configuração do conector")
  .action(async (o: { configEnv: string }) => {
    const { runExecWrapper } = await import("./mcp/execWrapper.js");
    await runExecWrapper(o.configEnv);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
