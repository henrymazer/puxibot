/**
 * `puxibot service`: só imprime arquivos para manter o runner ligado (systemd de usuário
 * no Linux/WSL2, launchd no macOS). Não instala nada nem executa comandos.
 */
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { distBundle } from "./self.js";

export interface ServiceFiles {
  systemd: string;
  systemdPath: string;
  launchd: string;
  launchdPath: string;
  command: string[];
}

function cliPath(): string {
  const dist = distBundle();
  if (dist) return dist;
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("não sei onde está o puxibot; rode a partir do runner instalado");
  try {
    return realpathSync(argv1);
  } catch {
    return path.resolve(argv1);
  }
}

function systemdQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function serviceFiles(env: NodeJS.ProcessEnv = process.env): ServiceFiles {
  const command = [process.execPath, cliPath(), "start"];
  // O serviço não herda o PATH do terminal: sem ele a CLI de IA (nvm, ~/.local/bin) não é encontrada.
  // Entradas do Windows (/mnt/c/... no WSL) não servem para o runner e só alongam a linha.
  const pathVar = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(path.delimiter)
    .filter((d) => d && !d.startsWith("/mnt/"))
    .join(path.delimiter);
  const vars: Record<string, string> = { PATH: pathVar };
  if (env.PUXIBOT_HOME) vars.PUXIBOT_HOME = path.resolve(env.PUXIBOT_HOME);

  const systemd = [
    "[Unit]",
    "Description=Runner do Puxibot (agentes do seu time nesta máquina)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${command.map(systemdQuote).join(" ")}`,
    ...Object.entries(vars).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    "Restart=on-failure",
    "RestartSec=10",
    "# Código 2: token recusado pelo hub (rode `puxibot login` de novo); não adianta reiniciar.",
    "RestartPreventExitStatus=2",
    "TimeoutStopSec=20",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  const logFile = path.join(os.homedir(), "Library", "Logs", "puxibot-runner.log");
  const launchd = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key><string>dev.puxibot.runner</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...command.map((c) => `    <string>${xml(c)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(vars).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>StandardOutPath</key><string>${xml(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  return {
    systemd,
    systemdPath: "~/.config/systemd/user/puxibot-runner.service",
    launchd,
    launchdPath: "~/Library/LaunchAgents/dev.puxibot.runner.plist",
    command,
  };
}
