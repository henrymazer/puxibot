# Prompt: ligar este computador a um Puxibot que já existe

Este arquivo é um roteiro para um agente de IA de terminal (Claude Code, Codex, Gemini CLI ou outro) instalar o runner do Puxibot para a pessoa que está conversando com ele. Serve para quem entrou num time que já tem o hub no ar. Quem prefere fazer à mão segue [runner.md](../runner.md).

Você, agente, vai instalar o comando `puxibot` neste computador e ligá-lo ao hub do time. Faça os passos você mesmo. Pare e fale com a pessoa só nos pontos marcados com **PARE**.

## Regras

- Nunca peça senha, token ou código de login pelo chat.
- Não use `--isolation none`, nem como solução provisória.
- Se um comando precisar de `sudo`, mostre o comando e peça que a pessoa o rode no terminal dela.
- Não crie contas nem aprove códigos de pareamento em nome da pessoa.
- Este roteiro não mexe na Cloudflare. Não rode `npm run deploy` nem comandos do Wrangler.
- Se algo falhar, consulte "Problemas comuns" em `docs/runner.md` antes de tentar outra coisa.

## 1. O que você precisa saber

**PARE** e pergunte à pessoa, se ela ainda não disse:

- o endereço do hub do time (algo como `https://puxibot-hub.<subdomínio>.workers.dev`);
- se ela já criou a conta dela nesse hub pelo link de convite. Se não, ela precisa fazer isso antes.

## 2. Conferir o computador

1. Sistema: Linux ou Windows com WSL2 (tudo dentro do WSL2). No macOS, avise que o runner não foi testado ali e pergunte se a pessoa quer tentar mesmo assim.
2. `node --version` precisa ser 22 ou mais novo (o `git` não é necessário). Se faltar, **PARE**, explique como instalar e espere.
3. Isolamento: confira se existe `bwrap` (bubblewrap), `podman` ou `docker` (por exemplo, `command -v bwrap podman docker`). Basta um deles. Se nenhum existir, **PARE** e peça que a pessoa rode `sudo apt install bubblewrap` (ou o equivalente da distribuição). Se o programa existe e funciona mesmo, quem diz é o `puxibot doctor`, no passo 4.

## 3. Instalar o comando `puxibot`

O hub do time serve o pacote do runner. Não é preciso clonar repositório nenhum. O pacote roda com o usuário da pessoa, fora do isolamento: instale só do endereço que ela deu para o hub do time dela, e só se começar com `https://`.

```bash
npm install -g <endereço do hub>/instalar/puxibot-runner.tgz
```

Se o `npm install -g` falhar por falta de permissão (acontece com o Node instalado pelo sistema), não use `sudo`: instale num prefixo seu, acrescentando `--prefix ~/.local` ao comando, e confira que `~/.local/bin` está no `PATH`.

`puxibot --version` confirma a instalação.

## 4. Conferir o ambiente

```bash
puxibot doctor
```

Leia o resultado com atenção; é ele que decide os próximos passos:

- **CLI de IA:** é preciso pelo menos uma com login feito. Se nenhuma estiver logada, **PARE** e peça que a pessoa faça o login dela (no Claude Code, rodando `claude`). Só o Claude Code foi testado; se houver Codex ou Gemini CLI, avise que esses dois adaptadores ainda não foram testados, mesmo que o Claude Code também esteja presente. Qual CLI cada agente usa é configurado no perfil do agente, na interface.
- **Runner não pareado:** é esperado o `doctor` listar isso em "O que falta" neste ponto; o pareamento é o próximo passo.
- **Isolamento:** vale o que o `doctor` disser, não a simples existência do programa. Se o `sandbox` aparecer indisponível mesmo com o bubblewrap instalado (o sistema pode bloquear namespaces de usuário) e houver `container`, use o modo container (veja "Deixar ligado"). Se nenhum dos dois estiver disponível, **PARE** e explique o que falta.

## 5. Parear

O comando imprime um código no formato `XXXX-XXXX` e um link, e fica esperando a aprovação por até 10 minutos. Rode-o em segundo plano, com a saída num arquivo, para conseguir ler o código enquanto ele espera:

```bash
LOG=$(mktemp -t puxibot-login.XXXXXX) && echo "$LOG"
puxibot login <endereço do hub> > "$LOG" 2>&1 &
sleep 5; cat "$LOG"
```

O `mktemp` cria um arquivo novo, só seu (não use um nome fixo em `/tmp`: outra pessoa no mesmo computador poderia criá-lo antes e mostrar um código dela). Se o seu terminal não guarda variáveis entre um comando e outro, use o caminho que o `echo` imprimiu.

**PARE**. Passe o link e o código à pessoa e peça que ela abra o link logada no Puxibot (ou digite o código em **Configurações › Computadores**) e aprove. Diga que ela só deve aprovar o código que você acabou de mostrar.

Espere o comando terminar com a mensagem "Aprovado!" nesse mesmo arquivo. Se o código expirar ou o comando falhar, rode de novo e passe o código novo. Depois da aprovação o computador ainda não aparece na lista da interface: ele só aparece quando o runner for ligado pela primeira vez, no próximo passo.

## 6. Deixar ligado

O runner precisa ficar ligado para os agentes trabalharem neste computador. Não o deixe como processo seu, porque ele morre quando esta conversa acabar. **PARE** e escolha com a pessoa:

- **Um terminal dela.** A pessoa abre um terminal (ou `tmux`) e roda `puxibot start`. Espere ela confirmar que rodou antes de conferir.
- **Serviço do systemd, que religa sozinho.** `puxibot service --systemd` imprime a unidade e os comandos de instalação. Com o "sim" da pessoa, você mesmo grava o arquivo e roda os comandos que ele imprimir (são do usuário, sem `sudo`); confira com `systemctl --user status puxibot-runner`. A unidade copia o `PATH` do terminal em que o comando foi rodado, então gere-a no ambiente normal da pessoa. No WSL2 isso exige o systemd ligado em `/etc/wsl.conf`, e o Linux só fica ligado enquanto o WSL estiver em execução no Windows.

Se o modo for container, grave essa escolha antes de ligar, para valer também no serviço: rode uma vez `puxibot start --isolation container --save` (Ctrl+C depois de conectar) ou peça que a pessoa use esse comando no terminal dela.

Confira com `puxibot status` e peça que a pessoa veja o computador como ligado em **Configurações › Computadores**.

## 7. Teste e relatório

Peça que a pessoa abra a conversa direta com o assistente pessoal dela (ou com um agente do qual ela é responsável) e mande uma mensagem. Numa conversa direta, quem executa é o computador de quem está na conversa, então é este runner que vai responder; a resposta costuma chegar em menos de um minuto. Se não chegar, veja o que o runner registrou (a saída do `puxibot start`, ou `journalctl --user -u puxibot-runner` no serviço) e consulte `docs/runner.md`.

Termine dizendo como o runner ficou ligado e como desligar (Ctrl+C no terminal, ou `systemctl --user stop puxibot-runner`). Desfazer a ligação com o hub é outra coisa: `puxibot logout` remove este computador do hub. Diga também o que ficou pendente, sem omitir nada.
