import { CopyBox } from "./CopyBox";

/**
 * Instruções para ligar um computador. O pacote do runner é servido pelo próprio hub
 * (scripts/bundle-runner.mjs o coloca em /instalar/puxibot-runner.tgz no build da interface),
 * então ninguém precisa do repositório nem de receber arquivo: instala direto deste endereço,
 * na mesma versão do hub. Outras formas de instalar estão em docs/runner.md.
 */
export const RUNNER_TARBALL_PATH = "/instalar/puxibot-runner.tgz";

/** Instala o runner a partir do hub. */
export function runnerInstallCommand(origin: string): string {
  return `npm install -g ${origin}${RUNNER_TARBALL_PATH}`;
}

/** Conecta ao hub e já fica executando depois da aprovação. */
export function runnerConnectCommand(origin: string): string {
  return `puxibot login ${origin} --start`;
}

export function InstallRunnerSteps({ hubUrl, compact }: { hubUrl?: string; compact?: boolean }) {
  const origin = (hubUrl ?? (typeof location !== "undefined" ? location.origin : "https://seu-hub")).replace(/\/+$/, "");
  const code = "font-mono text-xs";
  return (
    <ol className="space-y-4 text-sm">
      <li>
        <p className="mb-1.5 font-medium">1. Tenha uma CLI de IA instalada e logada</p>
        <p className="text-muted">
          Claude Code, Codex ou Gemini CLI (só o Claude Code foi testado de verdade). Os agentes usam a sua assinatura. Precisa de Node.js 22 ou mais novo e, no Linux,
          do bubblewrap para o isolamento (<code className={code}>sudo apt install bubblewrap</code>).
        </p>
        {!compact && <p className="mt-1 text-muted">No Windows, rode tudo dentro do WSL2.</p>}
      </li>
      <li>
        <p className="mb-1.5 font-medium">2. Rode no terminal</p>
        <CopyBox value={`${runnerInstallCommand(origin)}\n${runnerConnectCommand(origin)}`} label="Copiar comandos" className="whitespace-pre-wrap" />
        <p className="mt-1.5 text-muted">
          O primeiro comando instala o <code className={code}>puxibot</code> a partir deste endereço: quem publica o hub decide o código que roda no seu computador, então só instale de um hub em que você confia. O segundo mostra um código de pareamento e um link.
        </p>
      </li>
      <li>
        <p className="mb-1.5 font-medium">3. Aprove o código</p>
        <p className="text-muted">
          Abra o link que o terminal mostrou, ou digite o código no campo de pareamento em Configurações › Computadores. Só aprove um código que você mesmo gerou
          agora.
        </p>
        <p className="mt-1.5 text-muted">
          Depois da aprovação, o terminal fica executando os agentes; Ctrl+C encerra. Para ligar de novo mais tarde: <code className={code}>puxibot start</code>
          {!compact && (
            <>
              . Para conferir CLIs, logins e isolamento: <code className={code}>puxibot doctor</code>
            </>
          )}
          .
        </p>
      </li>
    </ol>
  );
}
