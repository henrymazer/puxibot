# Prompt: montar o Puxibot para um time

Este arquivo é um roteiro para um agente de IA de terminal (Claude Code, Codex, Gemini CLI ou outro) instalar o Puxibot para a pessoa que está conversando com ele. Quem prefere fazer à mão segue [instalacao.md](../instalacao.md).

Você, agente, vai publicar o hub do Puxibot na conta Cloudflare da pessoa e ligar o computador dela como runner. Faça os passos você mesmo, rodando os comandos. Pare e fale com a pessoa só nos pontos marcados com **PARE**: são coisas que só ela pode fazer ou decidir.

## Regras

- Nunca peça senha, token ou código de login pelo chat. Logins acontecem no navegador da pessoa ou num terminal dela.
- Não publique nada na Cloudflare antes de a pessoa confirmar, pelo nome, a conta que vai receber o hub.
- Não use `--isolation none` no runner, nem como solução provisória.
- Se um comando precisar de `sudo`, mostre o comando e peça que a pessoa o rode no terminal dela.
- Não crie contas, não aprove códigos de pareamento e não aceite termos em nome da pessoa.
- Se algo falhar, leia a mensagem, consulte a seção "E se…" de `docs/instalacao.md` e "Problemas comuns" de `docs/runner.md` antes de tentar outra coisa. Não contorne uma trava de segurança.
- Os guias em `docs/` são a referência. Se este roteiro e um guia divergirem, vale o guia; avise a pessoa da divergência.

## 1. Conferir o computador

1. Sistema: Linux ou Windows com WSL2 (tudo dentro do WSL2). No macOS, avise que o runner não foi testado ali e pergunte se a pessoa quer continuar só com o hub.
2. `node --version` precisa ser 22 ou mais novo, e o `git` precisa existir. Se faltar, **PARE**, explique como instalar e espere.
3. Isolamento do runner: confira se existe `bwrap` (bubblewrap), `podman` ou `docker` (por exemplo, `command -v bwrap podman docker`). Basta um deles. Se nenhum existir, **PARE** e peça que a pessoa rode `sudo apt install bubblewrap` (ou o equivalente da distribuição). Se o programa existe e funciona mesmo, quem diz é o `puxibot doctor`, no passo 6.

## 2. Obter o código

Se você já está dentro de um clone do repositório do Puxibot, use-o (trabalhe na raiz dele). Senão, clone o repositório de onde este arquivo veio numa pasta fixa, como `~/puxibot`, e entre nela; se você não souber o endereço do repositório, **PARE** e pergunte. Em qualquer dos casos, a pasta precisa continuar existindo: a configuração de produção do hub (`apps/hub/wrangler.production.jsonc`) fica dentro dela e é necessária para atualizar o hub depois. Avise a pessoa para não apagá-la nem movê-la. Depois:

```bash
npm install
```

## 3. Conta Cloudflare

**PARE** e confirme com a pessoa:

- ela tem uma conta na Cloudflare (o cadastro é gratuito, em https://dash.cloudflare.com/sign-up);
- o R2 está ativado na conta (painel da Cloudflare, menu **R2**; a ativação passa por um checkout mesmo na cota gratuita).

Depois faça o login do Wrangler. O comando abre uma página de autorização no navegador e espera a pessoa aprovar:

```bash
npx wrangler login
```

Se o navegador não abrir sozinho, passe à pessoa o endereço que o comando imprimir. Confira o resultado:

```bash
npx wrangler whoami
```

## 4. Publicar o hub

1. Veja o plano, sem criar nada:

   ```bash
   npm run deploy -- --dry-run
   ```

2. **PARE**. Mostre à pessoa:

   - o nome e o id da conta Cloudflare que o plano indicou (linha "Conta:"). Se o `whoami` listou mais de uma conta, pergunte qual;
   - o que será criado: um Worker, um banco D1, um bucket R2 e dois segredos gerados na hora;
   - que o roteador de mensagens usa o Workers AI da conta, que tem uma cota gratuita diária (detalhes em "Custos e limites" de `docs/deploy-cloudflare.md`). Para publicar sem ele, acrescente `--no-ai` aos comandos de deploy.

   Pergunte se é essa a conta e se pode publicar.

3. Só depois do "sim", publique. Sem terminal interativo, o script exige a conta confirmada na variável `PUXIBOT_DEPLOY_CONFIRM`:

   ```bash
   PUXIBOT_DEPLOY_CONFIRM=<account id> npm run deploy -- --yes --account-id <account id>
   ```

4. O script mostra o endereço do hub no fim (algo como `https://puxibot-hub.<subdomínio>.workers.dev`) e o comando recomendado para fixá-lo como público: é o mesmo comando do passo 3 acrescido de `--public-url <endereço>`. Rode-o. Quando o script disser para seguir `docs/instalacao.md`, continue neste roteiro.

5. Confira que o hub responde: `curl -s <endereço>/api/auth/signup-status` deve devolver `{"open":true,"firstAccount":true}`.

Detalhes e caminho manual: `docs/deploy-cloudflare.md`.

## 5. Primeira conta

**PARE**. Peça que a pessoa abra o endereço do hub agora, crie a conta dela e o workspace do time, e avise quando terminar. Explique o motivo: a primeira conta criada não precisa de convite e fecha o cadastro; enquanto ela não existir, qualquer pessoa com o endereço pode ocupá-la.

Quando ela avisar, confira: o mesmo `curl` deve devolver `"open":false`.

## 6. Ligar este computador (runner)

### 6.1 Instalar o comando `puxibot`

O hub que você acabou de publicar serve o pacote do runner:

```bash
npm install -g <endereço do hub>/instalar/puxibot-runner.tgz
```

Se o `npm install -g` falhar por falta de permissão (acontece com o Node instalado pelo sistema), não use `sudo`: instale num prefixo seu, acrescentando `--prefix ~/.local` ao comando, e confira que `~/.local/bin` está no `PATH`.

`puxibot --version` confirma a instalação.

### 6.2 Conferir o ambiente

```bash
puxibot doctor
```

Leia o resultado com atenção; é ele que decide os próximos passos:

- **CLI de IA:** é preciso pelo menos uma com login feito. Se nenhuma estiver logada, **PARE** e peça que a pessoa faça o login dela (no Claude Code, rodando `claude`). Só o Claude Code foi testado; se houver Codex ou Gemini CLI, avise que esses dois adaptadores ainda não foram testados, mesmo que o Claude Code também esteja presente. Qual CLI cada agente usa é configurado no perfil do agente, na interface.
- **Runner não pareado:** é esperado o `doctor` listar isso em "O que falta" neste ponto; o pareamento é o próximo passo.
- **Isolamento:** vale o que o `doctor` disser, não a simples existência do programa. Se o `sandbox` aparecer indisponível mesmo com o bubblewrap instalado (o sistema pode bloquear namespaces de usuário) e houver `container`, use o modo container (veja "Deixar ligado"). Se nenhum dos dois estiver disponível, **PARE** e explique o que falta.

### 6.3 Parear

O comando imprime um código no formato `XXXX-XXXX` e um link, e fica esperando a aprovação por até 10 minutos. Rode-o em segundo plano, com a saída num arquivo, para conseguir ler o código enquanto ele espera:

```bash
LOG=$(mktemp -t puxibot-login.XXXXXX) && echo "$LOG"
puxibot login <endereço do hub> > "$LOG" 2>&1 &
sleep 5; cat "$LOG"
```

O `mktemp` cria um arquivo novo, só seu (não use um nome fixo em `/tmp`: outra pessoa no mesmo computador poderia criá-lo antes e mostrar um código dela). Se o seu terminal não guarda variáveis entre um comando e outro, use o caminho que o `echo` imprimiu.

**PARE**. Passe o link e o código à pessoa e peça que ela abra o link logada no Puxibot (ou digite o código em **Configurações › Computadores**) e aprove. Diga que ela só deve aprovar o código que você acabou de mostrar.

Espere o comando terminar com a mensagem "Aprovado!" nesse mesmo arquivo. Se o código expirar ou o comando falhar, rode de novo e passe o código novo. Depois da aprovação o computador ainda não aparece na lista da interface: ele só aparece quando o runner for ligado pela primeira vez, no próximo passo.

### 6.4 Deixar ligado

O runner precisa ficar ligado para os agentes trabalharem neste computador. Não o deixe como processo seu, porque ele morre quando esta conversa acabar. **PARE** e escolha com a pessoa:

- **Um terminal dela.** A pessoa abre um terminal (ou `tmux`) e roda `puxibot start`. Espere ela confirmar que rodou antes de conferir.
- **Serviço do systemd, que religa sozinho.** `puxibot service --systemd` imprime a unidade e os comandos de instalação. Com o "sim" da pessoa, você mesmo grava o arquivo e roda os comandos que ele imprimir (são do usuário, sem `sudo`); confira com `systemctl --user status puxibot-runner`. A unidade copia o `PATH` do terminal em que o comando foi rodado, então gere-a no ambiente normal da pessoa. No WSL2 isso exige o systemd ligado em `/etc/wsl.conf`, e o Linux só fica ligado enquanto o WSL estiver em execução no Windows.

Se o modo for container, grave essa escolha antes de ligar, para valer também no serviço: rode uma vez `puxibot start --isolation container --save` (Ctrl+C depois de conectar) ou peça que a pessoa use esse comando no terminal dela.

Confira com `puxibot status` e peça que a pessoa veja o computador como ligado em **Configurações › Computadores**.

## 7. Teste final

Peça que a pessoa abra a conversa direta com o assistente pessoal dela (ou com um agente do qual ela é responsável) e mande uma mensagem. Numa conversa direta, quem executa é o computador de quem está na conversa, então é este runner que vai responder; a resposta costuma chegar em menos de um minuto. Se não chegar, veja o que o runner registrou (a saída do `puxibot start`, ou `journalctl --user -u puxibot-runner` no serviço) e consulte `docs/runner.md`.

## 8. Relatório

Termine dizendo à pessoa, em poucas linhas:

- o endereço do hub e em qual conta Cloudflare ele está;
- como o runner ficou ligado e como desligar (Ctrl+C no terminal, ou `systemctl --user stop puxibot-runner`). Desfazer a ligação com o hub é outra coisa: `puxibot logout` remove este computador do hub;
- como convidar o resto do time (**Equipe › Convidar**; cada pessoa convidada pode ligar o próprio computador com o roteiro `docs/prompts/ligar-computador.md`);
- o que não deu certo ou ficou pendente, sem omitir nada.
