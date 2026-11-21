# Instalação para um time

Este guia leva um time do zero até pessoas conversando com agentes: publicar o hub, criar a conta e o workspace, ligar os runners e convidar as pessoas. Leva uns 30 minutos para quem já tem uma CLI de IA funcionando.

Antes de começar, leia o [estado do projeto](../README.md#estado-do-projeto), que lista o que já foi testado e o que ainda não foi.

Se você usa uma CLI de IA, ela pode seguir este guia por você: veja os roteiros em [prompts/instalar-hub.md](prompts/instalar-hub.md) (montar o Puxibot do time) e [prompts/ligar-computador.md](prompts/ligar-computador.md) (ligar um computador a um hub que já existe).

## O que você vai instalar

- **Hub**: um só por time, na conta Cloudflare do time. É o endereço que todos abrem no navegador.
- **Runner**: um por computador que vai executar agentes. Não precisa ser em todos, mas um agente só trabalha quando está ligado o runner de quem pediu ou o do responsável pelo agente. Cada runner usa a assinatura de IA de quem o instalou.

## 1. Pré-requisitos

Quem publica o hub (uma pessoa):

- conta na Cloudflare, com o R2 ativado no painel (veja [deploy-cloudflare.md](deploy-cloudflare.md#antes-de-começar));
- Node.js 22 ou mais novo e o git.

Cada pessoa que vai rodar um runner:

- Linux ou Windows com WSL2 (macOS não foi testado);
- Node.js 22 ou mais novo (e o git, se for instalar o runner a partir do repositório);
- uma CLI de IA instalada e com login feito: Claude Code (testado), Codex ou Gemini CLI (não testados);
- para o isolamento: bubblewrap no Linux/WSL2 (`sudo apt install bubblewrap` no Ubuntu), ou Docker ou Podman para o modo container.

## 2. Publicar o hub

Na máquina de quem publica:

```bash
git clone <endereço-do-repositório> puxibot
cd puxibot
npm install
```

```bash
npx wrangler login
```

```bash
npm run deploy -- --dry-run
```

Confira o plano mostrado e publique (o script pergunta antes de criar ou publicar qualquer coisa):

```bash
npm run deploy
```

No fim, o script mostra o endereço do hub, algo como `https://puxibot-hub.seu-subdominio.workers.dev`. Fixe esse endereço como público (usado nos links de convite e pareamento):

```bash
npm run deploy -- --public-url https://puxibot-hub.seu-subdominio.workers.dev
```

Detalhes, caminho manual, notificações, domínio próprio e custos: [deploy-cloudflare.md](deploy-cloudflare.md).

Atenção: a primeira conta criada no hub não precisa de convite; as seguintes, sim. Crie a sua conta logo depois do deploy, antes que outra pessoa com o endereço faça isso, e leia [Antes de divulgar o endereço do hub](#antes-de-divulgar-o-endereço-do-hub).

## 3. Criar a conta e o workspace

1. Abra o endereço do hub e escolha criar conta (página `/cadastro`). Use nome, e-mail e uma senha.
2. Crie o workspace com o nome do time. Você vira dona ou dono (papel `owner`).
3. A configuração guiada abre em seguida: seu perfil, ligar o seu computador, a área de atuação do time, os agentes iniciais (o Puxibot pode montar de 3 a 5 agentes a partir da área escolhida) e chamar o time. Dá para pular passos e voltar depois.

Cada pessoa ganha automaticamente um assistente pessoal (um agente que só responde a ela) com um resumo diário às 9h.

## 4. Instalar e parear o runner em cada computador

Em cada computador que vai executar agentes. O guia completo está em [runner.md](runner.md); o resumo:

O hub serve o pacote do runner, então basta o endereço do hub:

```bash
npm install -g https://puxibot-hub.seu-subdominio.workers.dev/instalar/puxibot-runner.tgz
```

```bash
puxibot login https://puxibot-hub.seu-subdominio.workers.dev --start
```

O terminal mostra um código. Abra o link que aparece, ou vá em **Configurações › Computadores** na interface, e aprove o código. Só aprove um código que você mesmo gerou agora. Depois da aprovação o runner já fica ligado nesse terminal; para ligar de novo mais tarde, rode `puxibot start`. Para conferir CLIs, logins e isolamento antes: `puxibot doctor`.

(Também dá para instalar por um arquivo ou a partir do repositório; veja [runner.md](runner.md#instalação).)

O isolamento padrão é o `sandbox` (bubblewrap). A interface mostra o computador como ligado em **Configurações › Computadores**.

A interface também mostra estes passos em **Configurações › Computadores**.

## 5. Convidar pessoas

1. Vá em **Equipe** e clique em **Convidar** (só admins).
2. Copie o link do convite e mande para a pessoa. Ela abre o link, cria a conta e entra no workspace.
3. Ajuste o papel (Dono, Admin ou Membro) na lista da equipe, se precisar.

Não há envio de convite por e-mail nesta versão; o link é o convite.

## 6. Conversar com um agente

Abra a DM com um agente na barra lateral e peça algo. Num canal, chame o agente com `@handle`. Se nenhum runner que possa atender estiver ligado, o pedido fica na fila e a conversa avisa.

Numa DM, só o runner de quem está na conversa atende: quem fala em DM com o agente de outra pessoa precisa do próprio computador ligado. Detalhes em [runner.md](runner.md#em-que-computador-cada-pedido-roda).

Configurações de cada agente (instruções, quem pode falar, orçamento, ferramentas) ficam no perfil dele, em **Equipe**.

## 7. Atualizar para uma versão nova

O hub, por quem publicou:

```bash
git pull
npm install
npm run deploy
```

O deploy aplica as migrações novas do banco antes de publicar o código. Se uma migração falhar, nada é publicado. Para guardar uma cópia do banco antes, veja [deploy-cloudflare.md](deploy-cloudflare.md#atualizar-para-uma-versão-nova).

Os runners, em cada computador: instale o pacote da versão nova (`npm install -g ./puxibot-runner-<versão>.tgz`) ou, se instalou pelo repositório, rode na pasta dele:

```bash
git pull
npm install
npm run build -w @puxibot/runner
```

Depois, pare e inicie o `puxibot start` de novo. Atualize hub e runners juntos: o protocolo entre eles pode mudar entre versões.

## E se…

### Nenhum computador está online

Os agentes só trabalham com algum runner ligado. O pedido fica na fila, a conversa mostra "Nenhum computador ligado para executar agora" e quem pediu recebe um aviso. Quando um runner elegível conecta, o trabalho é executado sozinho.

O hub escolhe o runner nesta ordem: o de quem pediu, depois o do responsável pelo agente (só se ele enxergar a conversa: numa DM sua com o agente, o responsável não enxerga, então só o seu runner serve). Se só um colega está online mas não é nem quem pediu nem o responsável, o trabalho continua esperando. Rotinas agendadas rodam no runner do responsável.

### A CLI de IA não está logada

O trabalho falha e a conversa mostra o erro, e o responsável pelo agente é avisado. No computador do runner:

```bash
puxibot doctor
```

Faça o login que ele indicar, com o mesmo usuário que roda o `puxibot start`. Depois clique em **Tentar de novo** na conversa.

### O limite do plano de IA foi atingido

Cada runner usa a assinatura de quem o instalou. Quando ela chega ao limite, o trabalho falha com erro de limite e a conversa avisa. Opções: esperar o limite renovar e tentar de novo; pedir a quem tem outra assinatura que deixe o runner ligado; ou, nos agentes, definir um orçamento mensal de execuções e tokens para não esgotar a assinatura de ninguém. Lembre que cada execução do Claude Code já gasta dezenas de milhares de tokens de entrada com o contexto da CLI.

### O bubblewrap não está instalado

O `puxibot start` recusa iniciar no modo `sandbox` e avisa. No Ubuntu e no WSL2:

```bash
sudo apt install bubblewrap
```

Se ele está instalado e mesmo assim falha, o sistema pode estar bloqueando namespaces de usuário (o `puxibot doctor` mostra a mensagem). Enquanto isso, use o modo container, com Docker ou Podman:

```bash
puxibot start --isolation container
```

O modo `--isolation none` funciona sem nada, mas deixa o agente com acesso a todos os seus arquivos; use só para testar.

### O código de pareamento expirou

Ele vale 10 minutos. Rode `puxibot login <endereço>` de novo.

### A tela diz "muitas tentativas"

O hub limita tentativas para dificultar adivinhação de senha e de código: login, 10 por e-mail e 30 por endereço IP a cada 15 minutos; cadastro, 10 por IP por hora; pareamento, 20 códigos novos por IP e 10 aprovações por pessoa a cada 10 minutos. A mensagem diz quanto esperar.

### O login no hub falha logo depois do deploy

No plano gratuito da Cloudflare, cada requisição tem 10 ms de CPU, e o cálculo do hash da senha pode passar disso (não medido). Veja os pontos de atenção em [deploy-cloudflare.md](deploy-cloudflare.md#o-plano-gratuito-é-suficiente). Os logs do Worker mostram o erro:

```bash
cd apps/hub && npx wrangler tail -c wrangler.production.jsonc
```

## Antes de divulgar o endereço do hub

Depois da primeira conta, o cadastro em `/cadastro` fecha: novas pessoas só criam conta por um link de convite gerado por um admin, e quem abre a página sem convite vê um aviso. Para liberar o cadastro a qualquer pessoa com o endereço, acrescente `"OPEN_SIGNUP": "true"` em `vars` no `apps/hub/wrangler.jsonc` e rode `npm run deploy` de novo. Com o cadastro aberto, quem se cadastra sem convite cria o próprio workspace, separado do seu (não vê seus canais, pessoas, agentes nem arquivos), mas consome a cota da sua conta Cloudflare (até 20 workspaces por pessoa).

Se o endereço vai circular além do time, ponha o Cloudflare Access (camada de login da Cloudflare) na frente do hub:

1. Use um domínio próprio para o hub (seção "Domínio próprio" em [deploy-cloudflare.md](deploy-cloudflare.md#domínio-próprio)); proteger o endereço `workers.dev` com o Access não foi conferido.
2. No painel Zero Trust da Cloudflare, crie uma aplicação self-hosted para esse domínio e uma política que só deixe entrar os e-mails do time.
3. Deixe de fora do Access os caminhos que o runner usa, porque ele não passa por login de navegador: `/api/runner/*`, `/api/workspaces/*/runner`, `/api/workspaces/*/runners/*`, `/api/tool/*` e `/api/me`. Todos já exigem token.

Essa combinação não foi testada; detalhes e custos em [deploy-cloudflare.md](deploy-cloudflare.md#cloudflare-access-na-frente-opcional).

O que conferir antes de mandar o link:

- você já criou a sua conta e o workspace do time (a primeira conta não tem nenhum privilégio especial no hub; cada workspace tem o próprio dono);
- `PUBLIC_URL` aponta para o endereço que as pessoas vão usar (links de convite e de pareamento);
- os convites têm validade e número de usos que façam sentido (em **Equipe › Convidar**);
- os agentes com acesso a conectores ou a dados sensíveis estão com "quem pode falar" e orçamento ajustados (perfil do agente, aba Configurações);
- os logs do Worker não mostram erro de limite de CPU no login (`npx wrangler tail -c wrangler.production.jsonc`, em `apps/hub`).
