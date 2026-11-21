# Runner (`puxibot`)

O runner é o programa que executa os agentes do seu time no seu computador. Ele se conecta ao hub por um WebSocket de saída (seu computador não precisa de endereço público), recebe os trabalhos, roda a CLI de IA que você já usa e devolve a resposta. Cada pessoa do time que quiser emprestar a própria assinatura de IA aos agentes instala um runner.

## Requisitos

- Linux, ou Windows com WSL2 (rode tudo dentro do WSL2). macOS está escrito, mas não foi testado.
- Node.js 22 ou mais novo e o git.
- Pelo menos uma CLI de IA instalada e com login feito:
  - Claude Code: rode `claude` e entre com sua conta;
  - Codex: `codex login`;
  - Gemini CLI: rode `gemini` uma vez e escolha "Login with Google" (ou defina `GEMINI_API_KEY`).
- Para o isolamento padrão no Linux/WSL2, o bubblewrap. No Ubuntu e no WSL2 com Ubuntu:

```bash
sudo apt install bubblewrap
```

- Opcional, para o modo container: Docker ou Podman.

## Instalação

O pacote ainda não é publicado no npm. Há três caminhos, todos testados no Linux/WSL2.

### Pelo hub do time (recomendado)

O hub serve o pacote do runner, na mesma versão do hub. Não precisa do repositório nem de receber arquivo:

```bash
npm install -g https://<endereço do hub>/instalar/puxibot-runner.tgz
```

Em seguida, um comando conecta ao hub e já deixa o runner ligado depois da aprovação:

```bash
puxibot login https://<endereço do hub> --start
```

A interface mostra esses dois comandos prontos para copiar, com o endereço certo, em **Configurações › Computadores**. Para atualizar depois de o hub ser atualizado, rode o `npm install -g` de novo e reinicie o `puxibot start`.

**Quem publica o hub entrega o código que roda no seu computador.** O pacote vem do hub e roda com o seu usuário, fora de qualquer isolamento. Só instale assim de um hub em que você confia (o do seu time, publicado por quem você conhece). Se não confia, instale a partir do repositório (veja "A partir do repositório", abaixo) e confira o código.

O `puxibot login` só aceita endereço `https://` (ou `http://` para um hub em `localhost`, `127.0.0.1` ou `::1`, no desenvolvimento): sem criptografia, o token do runner e os trabalhos passariam abertos pela rede.

Se o `npm install -g` pedir permissão de administrador, instale num prefixo seu, acrescentando `--prefix ~/.local`, e ponha `~/.local/bin` no `PATH`.

### Pelo pacote (tarball)

Alguém do time que tem o repositório gera o arquivo, na pasta do repositório:

```bash
npm install
npm run pack -w @puxibot/runner
```

Isso compila o runner e cria `apps/runner/puxibot-runner-<versão>.tgz` (hoje, `puxibot-runner-0.1.1.tgz`), um arquivo único sem dependências externas. Passe esse arquivo para cada pessoa. Em cada computador, na pasta onde o arquivo está:

```bash
npm install -g ./puxibot-runner-0.1.1.tgz
```

Se o `npm install -g` pedir permissão de administrador, instale num prefixo seu e ponha a pasta `bin` dele no `PATH`:

```bash
npm install -g --prefix ~/.local ./puxibot-runner-0.1.1.tgz
```

Confira:

```bash
puxibot --version
```

Para atualizar, instale o arquivo da versão nova do mesmo jeito e reinicie o `puxibot start`.

### A partir do repositório

```bash
git clone <endereço-do-repositório> puxibot
cd puxibot
npm install
```

```bash
npm run build -w @puxibot/runner
```

```bash
cd apps/runner && npm link
```

O `npm link` deixa o comando `puxibot` disponível no terminal (`puxibot --version` confere). Se preferir não usar o `npm link`, rode o runner pelo caminho completo: `node <pasta-do-repositório>/apps/runner/dist/cli.js <comando>`.

Para atualizar, na pasta do repositório: `git pull`, `npm install` e `npm run build -w @puxibot/runner`. Reinicie o `puxibot start` depois.

## Primeiros passos

### 1. Conferir o ambiente

```bash
puxibot doctor
```

Mostra as CLIs de IA encontradas, se têm login, que isolamento está disponível e o que falta.

### 2. Conectar ao hub

```bash
puxibot login https://puxibot-hub.seu-subdominio.workers.dev
```

O terminal mostra um código de pareamento (formato `XXXX-XXXX`) e um link. Abra o link logado no Puxibot, ou digite o código em **Configurações › Computadores**, e aprove. O runner fica ligado ao workspace em que você aprovou, com as suas permissões. O código vale 10 minutos. Depois de aprovar, a interface mostra o nome que o computador informou.

Só aprove um código que você mesmo gerou agora no seu computador. Aprovar o código de outra pessoa liga o computador dela à sua conta: ele passa a receber os seus pedidos aos agentes, com o conteúdo das suas conversas. O hub limita as tentativas de aprovação a 10 a cada 10 minutos por pessoa.

Alternativa sem pareamento: crie um token do tipo "Computador (runner)" em **Configurações › Tokens pessoais** e passe direto:

```bash
puxibot login https://seu-hub --token tb_... --workspace <id-do-workspace>
```

### 3. Deixar rodando

```bash
puxibot start
```

Enquanto o `puxibot start` estiver rodando, os agentes podem trabalhar no seu computador e a interface mostra o computador como ligado. Ctrl+C encerra; trabalhos em andamento voltam para a fila do hub. Se o runner cair sem encerrar (falta de energia, `kill -9`), o hub percebe a queda e devolve o trabalho para a fila; quando um runner elegível conecta, o trabalho recomeça do zero.

### Em que computador cada pedido roda

O hub só entrega um trabalho ao runner de alguém que enxerga a conversa e pode falar com o agente:

- **conversa direta (DM) com um agente**: só o runner de quem está na conversa. Se você fala em DM com um agente de outra pessoa, é o **seu** computador que precisa estar ligado; o do responsável pelo agente não enxerga a sua DM. Sem ele, o pedido espera e a conversa avisa;
- **canal**: o runner de quem pediu e, se ele estiver desligado, o do responsável pelo agente;
- **rotina agendada**: o runner do responsável pelo agente ("executar agora" usa o de quem clicou);
- **consulta entre agentes**: o mesmo runner do trabalho que fez a consulta.

Um conector (servidor MCP cadastrado em **Configurações › Conectores**) só vai junto quando o trabalho roda no computador de quem conectou; em outro computador, o agente trabalha sem ele.

## Comandos

| Comando | O que faz |
|---|---|
| `puxibot login <hubUrl>` | Pareia este computador com um hub. Opções: `--start` (já fica executando depois da aprovação), `--token`, `--workspace`, `--name`. |
| `puxibot start` | Conecta e executa os trabalhos. Opções: `--isolation sandbox|container|none`, `--capacity <n>` (trabalhos ao mesmo tempo, padrão 1), `--name`, `--save` (grava as opções como padrão). |
| `puxibot status` | Mostra hub, workspace, isolamento padrão e se o runner está rodando. |
| `puxibot logout` | Remove este runner do hub e apaga o token local. |
| `puxibot doctor` | Verifica CLIs, logins e isolamento. `--json` para saída em JSON. |
| `puxibot service` | Imprime (sem instalar) uma unidade do systemd e um plist do launchd para manter o runner ligado. |
| `puxibot mcp` | Servidor MCP das ferramentas do Puxibot. Você não roda isto: a CLI de IA o inicia durante cada trabalho. |

`puxibot <comando> --help` mostra os detalhes de cada um.

## Isolamento

O runner envolve a CLI de IA numa camada de isolamento, com as mesmas regras para qualquer CLI. O sandbox próprio de cada CLI não é usado como camada de segurança do Puxibot.

| Modo | Como funciona | Requisito |
|---|---|---|
| `sandbox` (padrão) | bubblewrap no Linux/WSL2; Seatbelt (`sandbox-exec`) no macOS, não testado | `bubblewrap` instalado; namespaces de usuário liberados no sistema |
| `container` | Um container por trabalho, removido ao terminar. A imagem é construída na primeira vez a partir de `apps/runner/docker/Dockerfile` (pode levar alguns minutos) | Docker ou Podman funcionando com o seu usuário. Testado com Docker e com Podman 4.9 sem root no Linux/WSL2 |
| `none` | Sem isolamento | Nenhum. Só para testes |

Para escolher o modo padrão: `puxibot start --isolation container --save`.

### O que o modo `sandbox` protege

- O agente só escreve na própria pasta de trabalho (`~/.puxibot/workspaces/<ws>/agents/<agente>`), no estado da CLI desse agente (`~/.puxibot/cli-state/<cli>/<ws>/<agente>`) e num `/tmp` novo, criado para o trabalho. Cada agente tem o próprio estado da CLI: um agente não lê nem altera as conversas, memórias ou configurações da CLI de outro agente.
- O runner nunca segue links simbólicos dentro dessas pastas. Quando grava as skills e os arquivos de instruções (`AGENTS.md`, `GEMINI.md`, `.gemini/settings.json`) ou refaz o link do login, um link deixado pelo agente é apagado e trocado por um arquivo de verdade, sem tocar o destino do link.
- Ficam escondidas: sua pasta pessoal e todo o `/home`, `/root`, `/mnt` (no WSL2, o disco do Windows), `/media`, discos externos e de rede, a pasta do runner (`~/.puxibot` ou `PUXIBOT_HOME`, onde está o token) e sockets que permitiriam escapar (Docker, Podman, D-Bus e toda a pasta `/run/user`, mesmo quando `XDG_RUNTIME_DIR` não está definida). O `/tmp` e o `/var/tmp` do seu computador não aparecem.
- Variáveis de ambiente: a CLI recebe só `PATH`, `LANG`, `LC_*`, `TERM`, `TZ`, `HOME`, `USER`, `LOGNAME`, `SHELL`, as de proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`) e de certificados (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`), as do login por chave que o adaptador conhece (no Gemini CLI, `GEMINI_API_KEY`, `GOOGLE_API_KEY` e as do Vertex AI) e as do próprio trabalho. Tokens e chaves do seu terminal (`GH_TOKEN`, `AWS_*`, `DATABASE_URL`...) não passam. Para liberar uma variável, ponha o nome em `"env": { "pass": ["NOME"] }` no `config.json` (por exemplo, `ANTHROPIC_API_KEY` se o seu Claude Code usa chave de API). Vale também no modo `container`.
- Conectores: as variáveis de um conector (definidas no hub) vão só para o servidor do conector, nunca para o ambiente da CLI nem do isolamento, e nomes que mudariam o funcionamento do runner (`PATH`, `HOME`, `LD_*`, `NODE_OPTIONS`, `CODEX_HOME`, `CLAUDE_*`, `GEMINI_*`, `PUXIBOT_*`) são ignorados, com um aviso no trabalho. O comando de um conector stdio só roda se já estiver visível no sandbox; se ficar numa pasta escondida (sua pasta pessoal, `~/.puxibot`, `/mnt`...), o conector fica desligado naquele trabalho, com um aviso. Para usar um conector instalado na sua pasta pessoal, libere a pasta dele em `sandbox.extraReadOnly`.
- Pastas de chaves (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.config/gcloud`) e os arquivos `~/.netrc`, `~/.git-credentials` e `~/.npmrc` continuam escondidos mesmo dentro de uma pasta que você liberar.
- Continuam visíveis, só para leitura, as pastas do sistema (`/usr`, `/etc`, `/bin`, `/lib*`, `/opt`...), o binário da CLI e do Node e o próprio runner (para o `puxibot mcp`).
- Para liberar uma pasta sua ao agente, use `sandbox.extraReadOnly` ou `sandbox.extraWritable` no `config.json`; para esconder algo dentro de uma pasta liberada, `sandbox.hidePaths` (veja abaixo).

O `puxibot doctor` mostra a lista exata do que fica escondido, somente leitura e com escrita no seu computador.

### O que o modo `sandbox` não protege

- **Rede**: liberada por padrão, porque a CLI precisa falar com o provedor do modelo. O agente pode acessar qualquer endereço da internet e da sua rede local. `"sandbox": { "network": false }` corta toda a rede, inclusive a do modelo; só serve para CLIs com modelo local.
- **Credenciais da CLI**: o login da própria CLI de IA fica acessível ao processo (a CLI precisa dele para funcionar). Um agente mal-intencionado, ou instruído por conteúdo malicioso que ele leu, pode tentar ler e enviar esse login para fora.
- **Login durante a renovação do token**: quando o token de acesso da CLI vence antes do fim do trabalho, o arquivo de login fica com escrita naquele trabalho, para a CLI gravar o token novo (no Claude Code, só nesse caso; no Codex e no Gemini CLI, em todo trabalho). Nesse trabalho, o agente pode alterar o seu arquivo de login. Fora disso, o runner nunca copia para o seu login um arquivo deixado pelo agente, e mesmo nesse caso só copia um arquivo comum com o formato de login da CLI.
- **Ferramentas do sistema**: o agente usa o que está instalado na máquina, não um ambiente limpo.

Quem dá mais autonomia aos agentes deve preferir o modo `container`, que parte de uma imagem limpa a cada trabalho. Ele também monta as credenciais da CLI (somente leitura quando possível), recebe só as mesmas variáveis de ambiente do modo `sandbox` e não restringe a rede por padrão. O endereço do hub que decide a rede do container (`--network host` só para um hub em `localhost`) é sempre o do seu `config.json`, nunca o que vem no trabalho; para restringir, use `"container": { "network": "<rede>" }` com uma rede do Docker/Podman que passe por um proxy com lista de endereços permitidos.

### Modo `none`

O agente roda com o seu usuário e pode ler e alterar qualquer arquivo que você pode. O runner mostra um aviso ao iniciar. Use só para testar.

## Onde ficam os arquivos

Tudo em `~/.puxibot` (ou na pasta definida em `PUXIBOT_HOME`):

| Caminho | Conteúdo |
|---|---|
| `config.json` | Hub, workspace, id do runner e preferências (sem segredos) |
| `token` | Token do runner (`tb_...`), permissão 600 |
| `sessions.json` | Sessões das CLIs, para retomar conversas |
| `runner.pid` | Processo do `puxibot start` em execução |
| `workspaces/<ws>/agents/<agente>/` | Pasta de trabalho de cada agente |
| `cli-state/<cli>/<ws>/<agente>/` | Estado da CLI de cada agente, separado do seu (hooks, plugins e servidores MCP pessoais não vazam para o agente) e do dos outros agentes. Pastas antigas `cli-state/<cli>/` sem workspace ficam sem uso e podem ser apagadas |
| `run/<job>/` | Temporários de um trabalho, apagados ao terminar |

Opções úteis do `config.json`:

```json
{
  "isolation": "sandbox",
  "capacity": 1,
  "defaultCli": "claude",
  "models": { "claude": "sonnet" },
  "cliPaths": { "claude": "/caminho/para/claude" },
  "sandbox": { "extraReadOnly": ["~/projetos/site"], "extraWritable": [], "hidePaths": ["~/projetos/site/.env"], "network": true },
  "env": { "pass": ["ANTHROPIC_API_KEY"] },
  "memory": { "auto": true, "model": "haiku" },
  "container": { "runtime": "podman", "network": "bridge" }
}
```

O valor de `models` acima é só um exemplo; use um nome de modelo que a sua CLI aceite.

## Memória dos agentes

O que um agente sabe de uma conversa para a outra fica em três lugares:

- **Memórias gravadas, no hub.** Fatos curtos, do agente ou do time inteiro. Valem em qualquer computador.
- **Mensagens da conversa, no hub.** A cada trabalho o hub manda as mais recentes.
- **Sessão da CLI, neste computador.** A conversa completa, com o raciocínio do agente. Não acompanha o agente quando ele roda no computador de outra pessoa.

Por isso, o que precisa durar tem de virar memória gravada. Isso acontece de dois jeitos:

- o agente grava ou apaga por conta própria, com as ferramentas `lembrar` e `esquecer`;
- **revisão automática**: depois de entregar cada resposta, o runner faz uma segunda chamada à CLI, curta e sem ferramentas, que lê o pedido, a resposta e as memórias atuais e decide o que guardar e o que já não vale (ficou errado, foi substituído, é repetição ou trata de algo que acabou).

Limites da revisão automática, aplicados pelo hub:

- no máximo 3 memórias novas e 3 apagadas por trabalho, cada uma com até 500 caracteres;
- nunca apaga uma memória escrita por uma pessoa na interface, só as que vieram de agentes ou de revisões anteriores;
- só roda se o agente tem permissão de escrita em memória;
- o que entrou e o que saiu fica registrado no próprio trabalho ("Memória revisada"), e as memórias criadas assim aparecem como "extraída de conversa" no perfil do agente.

Custo: com o Claude Code, cerca de mil tokens de entrada por trabalho, no modelo `haiku`, somados ao trabalho e ao orçamento do agente. A resposta não espera pela revisão.

Hoje só o adaptador do Claude Code faz a revisão; com Codex e Gemini CLI ela não roda. Para desligar neste computador, ponha `"memory": { "auto": false }` no `config.json`; `"model"` troca o modelo usado.

A revisão lê conteúdo que pode ser malicioso (uma mensagem colada, uma página da web resumida pelo agente). Ela não tem ferramentas e só consegue propor mudanças dentro dos limites acima, mas um texto feito para isso pode fazê-la guardar uma informação falsa. Confira as memórias de tempos em tempos no perfil de cada agente.

## Manter ligado

Os agentes só trabalham com algum runner ligado. Opções:

- Um terminal aberto (ou `tmux`/`screen`) com `puxibot start`.
- Serviço de usuário do systemd (Linux, ou WSL2 com systemd ligado em `/etc/wsl.conf`). O comando abaixo imprime a unidade e as instruções de instalação, sem instalar nada:

```bash
puxibot service --systemd
```

No WSL2, o Linux só fica ligado enquanto o WSL estiver em execução no Windows. O plist do launchd para macOS (`puxibot service --launchd`) não foi testado.

## Estado de cada CLI

| CLI | Estado |
|---|---|
| Claude Code | Testado de verdade no Linux/WSL2, com o runner instalado pelo pacote e no modo `sandbox`: responde em DM (com streaming), cria tarefas e memórias, escreve na wiki, salva no drive, consulta outros agentes, pede aprovação e roda rotinas. No macOS o login fica no Keychain e o caminho não foi testado. |
| Codex | Adaptador escrito a partir da documentação e do `--help`; nunca rodou com a CLI real. |
| Gemini CLI | Adaptador escrito a partir da documentação; nunca rodou com a CLI real. |

O `puxibot doctor` marca os adaptadores ainda não testados.

Cada ida do Claude Code ao modelo leva cerca de 16 mil tokens de entrada de contexto fixo: as instruções da própria CLI, a descrição das ferramentas nativas e a das ferramentas do Puxibot. Cada uso de ferramenta é uma ida a mais, então um trabalho com uma ferramenta gasta cerca de 33 mil (medido com o modelo haiku). Boa parte é leitura de cache, mas conta no limite da sua assinatura.

Para manter esse custo baixo, o runner libera ao Claude Code só as ferramentas nativas `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch` e `WebFetch`. Com o conjunto completo, o mesmo trabalho gastava cerca de 69 mil. Para trocar a lista, defina `PUXIBOT_CLAUDE_TOOLS` com os nomes separados por vírgula (`default` libera todas). As skills de um agente entram só como resumo; o texto completo fica num arquivo que o agente lê quando a skill se aplica.

## Privacidade e termos de uso

- **Dados do time**: ficam na Cloudflare, na conta do seu time (banco D1, com as mensagens, e arquivos no R2). Nenhum servidor do projeto Puxibot recebe esses dados.
- **Conversas com agentes**: o runner manda ao provedor do modelo (Anthropic, OpenAI ou Google, conforme a CLI) as instruções do agente, as mensagens recentes da conversa e o que o agente ler pelas ferramentas (tarefas, wiki, arquivos). O tratamento desses dados segue a política do provedor e o tipo da sua conta.
- **Arquivos do seu computador**: no modo `sandbox` ou `container`, o agente não alcança sua pasta pessoal, exceto o que você liberar.
- **Assinatura pessoal**: o runner usa a sua CLI, com o seu login. Quando o trabalho cai no seu runner, é a sua assinatura que paga, inclusive por pedidos de outras pessoas do time quando você é o responsável pelo agente. O uso da assinatura de cada CLI segue os termos de cada provedor. Leia os termos atuais do seu plano antes de usar a sua assinatura para atender pedidos de outras pessoas ou de forma automatizada.

## Problemas comuns

- **`isolamento sandbox indisponível`**: instale o bubblewrap (`sudo apt install bubblewrap`). Se já está instalado e falha, o sistema pode estar bloqueando namespaces de usuário (o `puxibot doctor` mostra o erro). Enquanto isso, use `--isolation container`.
- **CLI sem login**: o `puxibot doctor` aponta qual. Faça o login no mesmo usuário que roda o `puxibot start`.
- **Token revogado**: se alguém removeu o runner na interface, o `puxibot start` para de reconectar e pede um novo `puxibot login`.
- **Pedido esperando na DM com o agente de outra pessoa**: é o seu computador que precisa estar ligado (veja "Em que computador cada pedido roda").
- **O agente não responde**: veja a seção "E se…" de [instalacao.md](instalacao.md#e-se).
