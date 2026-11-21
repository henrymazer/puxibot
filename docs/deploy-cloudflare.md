# Deploy do hub na Cloudflare

Este guia explica em detalhe como o hub vai para a conta Cloudflare do seu time: que recursos ele usa, como criá-los, que segredos definir, quanto consome e o que o plano gratuito cobre. Para o passo a passo do time inteiro (contas, runners, convites), veja [instalacao.md](instalacao.md).

Situação deste guia: o script `npm run deploy` foi executado uma vez contra uma conta Cloudflare real, durante o desenvolvimento, e funcionou até publicar o Worker. O hub publicado não foi usado nem testado. Os limites do plano gratuito na prática continuam sem verificação, em especial se o login cabe no limite de CPU por requisição, por causa do PBKDF2 (veja "O plano gratuito é suficiente?"). Os números de limites e preços abaixo foram conferidos na documentação da Cloudflare em 21/11/2026; eles mudam, então confira os links antes de decidir.

## O que o hub usa

| Recurso | Para quê | Nome padrão |
|---|---|---|
| Worker (com static assets) | API em `/api/*` e a interface web (o resto dos caminhos) | `puxibot-hub` |
| D1 (banco SQLite gerenciado) | Contas, workspaces, canais, agentes, tarefas, wiki, permissões | `puxibot` (binding `DB`) |
| R2 (armazenamento de arquivos) | Arquivos do drive e anexos | `puxibot-files` (binding `FILES`) |
| Durable Objects, classe SQLite | Um objeto por workspace: tempo real (WebSockets), fila de trabalho, rotinas | classe `WorkspaceHub` (binding `WORKSPACE_HUB`) |
| Cron Trigger | Rede de segurança das rotinas, a cada 30 minutos | `*/30 * * * *` |
| Workers AI (opcional) | Roteador: escolhe qual agente responde num canal sem menção | binding `AI` |

Os nomes vêm de `apps/hub/wrangler.jsonc`. Se você mudar algum, mude ali antes do primeiro deploy.

## Antes de começar

1. Uma conta Cloudflare (o cadastro é gratuito).
2. O R2 ativado na conta. A documentação do R2 diz que é preciso "uma conta Cloudflare com assinatura do R2" e concluir o checkout no painel, mesmo para usar só a cota gratuita ([Get started do R2](https://developers.cloudflare.com/r2/get-started/)). No painel, abra **R2** e siga a ativação. A página não diz se é exigido cartão de crédito; confira no painel.
3. Node.js 22 ou mais novo e o repositório clonado com `npm install` feito.
4. Login do Wrangler (a CLI da Cloudflare, já instalada pelo `npm install`):

```bash
npx wrangler login
```

Para conferir o login e a conta:

```bash
npx wrangler whoami
```

Em CI, ou para usar um token com permissões restritas, defina `CLOUDFLARE_API_TOKEN` (e `CLOUDFLARE_ACCOUNT_ID` se o token alcança mais de uma conta) em vez do `wrangler login`. Veja [permissões do Wrangler](https://developers.cloudflare.com/workers/authorization/workers/).

## Caminho automático: `npm run deploy`

Na raiz do repositório:

```bash
npm run deploy -- --dry-run
```

O `--dry-run` mostra o que seria feito e confere se o pacote do Worker é gerado, sem criar nem publicar nada (funciona até sem login). Com login, ele só consulta a conta: lista os bancos D1, confere se o bucket R2 existe e lista os nomes dos segredos do Worker. Depois:

```bash
npm run deploy
```

O script (`scripts/deploy-hub.mjs`):

1. confere o login (`wrangler whoami`) e escolhe a conta;
2. procura o banco D1 e o bucket R2 pelo nome e cria os que não existirem;
3. confere quais segredos obrigatórios o Worker já tem;
4. mostra o plano e pede confirmação;
5. grava `apps/hub/wrangler.production.jsonc` (veja abaixo);
6. compila a interface;
7. aplica as migrações pendentes no banco remoto;
8. publica o Worker, enviando junto os segredos obrigatórios que faltavam, gerados aleatoriamente e nunca mostrados;
9. mostra o endereço final.

Pode rodar quantas vezes quiser: o que já existe é reaproveitado. Segredos já definidos nunca são substituídos (trocar o `SECRETS_KEY` tornaria ilegíveis as credenciais de conectores gravadas).

O `npm run deploy -w @puxibot/hub` também chama este script (não há atalho para um `wrangler deploy` direto).

### Sem perguntas (CI)

O script sempre pergunta antes de criar ou publicar. Para rodar sem terminal interativo, ele exige as duas coisas juntas:

- a opção `--yes`;
- a variável `PUXIBOT_DEPLOY_CONFIRM` com o account id ou o nome da conta Cloudflare que vai receber o deploy.

```bash
PUXIBOT_DEPLOY_CONFIRM=<account id> npm run deploy -- --yes --account-id <account id>
```

Sem terminal e sem essas duas, ou com `--yes` sem a variável, o script para com erro antes de falar com a Cloudflare. Se a variável não bater com a conta escolhida, ele para depois de identificar a conta e antes de criar ou publicar qualquer coisa. Assim, um `--yes` copiado de outro lugar, ou rodado na máquina errada, não publica nada sozinho.

Opções:

| Opção | Efeito |
|---|---|
| `--dry-run` | Só mostra o plano e testa o empacotamento. |
| `--yes` | Não pergunta nada (para CI). Só funciona junto com `PUXIBOT_DEPLOY_CONFIRM=<account id ou nome da conta>` (veja acima). |
| `--no-ai` | Publica sem o binding `AI` (roteador desligado). Vale só para aquele deploy; o padrão é ligado. |
| `--public-url <url>` | Grava `PUBLIC_URL`. Fica guardado para os próximos deploys. |
| `--account-id <id>` | Conta Cloudflare a usar, quando o login alcança várias. Também aceita `CLOUDFLARE_ACCOUNT_ID`. |
| `--location <dica>` | Região preferida do banco na criação: `weur`, `eeur`, `apac`, `oc`, `wnam` ou `enam`. Sem ela, a Cloudflare escolhe perto de quem cria. |

Para que a tela "Instalar o runner" da interface mostre o endereço certo do repositório, defina `VITE_PUXIBOT_REPO` ao publicar:

```bash
VITE_PUXIBOT_REPO=https://github.com/seu-time/puxibot.git npm run deploy
```

### Onde fica a configuração de produção

O `apps/hub/wrangler.jsonc` versionado não tem ids de nenhuma conta, e o script não o altera. Os ids ficam em `apps/hub/wrangler.production.jsonc`, gerado a partir do versionado e ignorado pelo git. Todos os comandos de produção usam esse arquivo com `-c` (ou `--config`, opção global do Wrangler).

Escolhemos um arquivo gerado, e não um ambiente do Wrangler (`env.production` dentro do `wrangler.jsonc`), porque ambientes ficam no mesmo arquivo versionado e exigem repetir todos os bindings em cada ambiente ([Environments](https://developers.cloudflare.com/workers/wrangler/environments/)), o que levaria os ids da conta para o git.

A cada deploy o arquivo é regenerado a partir do `wrangler.jsonc`. São preservados: `account_id`, `database_id`, `PUBLIC_URL`, `routes` e `workers_dev`. Se você perder o arquivo, rode `npm run deploy` de novo: o banco é reencontrado pelo nome.

## Caminho manual

Use este caminho se quiser entender cada passo ou se o script falhar. Todos os comandos rodam em `apps/hub`.

```bash
cd apps/hub
```

### 1. Banco D1

```bash
npx wrangler d1 create puxibot
```

Anote o `database_id` que aparece (ou consulte depois com `npx wrangler d1 list`).

### 2. Bucket R2

```bash
npx wrangler r2 bucket create puxibot-files
```

### 3. Configuração de produção

Copie o arquivo versionado:

```bash
cp wrangler.jsonc wrangler.production.jsonc
```

No `wrangler.production.jsonc`, acrescente o `database_id` no banco e o binding do Workers AI no nível de cima:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "puxibot",
    "database_id": "<id do passo 1>",
    "migrations_dir": "migrations"
  }
],
"ai": { "binding": "AI" },
```

Se você não preencher o `database_id`, o `wrangler deploy` cria um banco novo sozinho (provisionamento automático) e grava o id de volta no arquivo ([configuração do Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)). Isso cria um banco com nome diferente do que as migrações esperam; prefira preencher.

### 4. Migrações no banco remoto

```bash
npx wrangler d1 migrations apply puxibot --remote -c wrangler.production.jsonc
```

O Wrangler registra as migrações aplicadas numa tabela do banco (`d1_migrations`) e aplica só as pendentes. Ele pede confirmação e faz um backup antes; em terminal não interativo a confirmação é pulada.

### 5. Segredos obrigatórios

| Segredo | Para quê | Formato |
|---|---|---|
| `JOB_TOKEN_SECRET` | Assina (HMAC) o token que cada execução de agente usa para chamar as ferramentas do hub | Texto longo aleatório |
| `SECRETS_KEY` | Cifra (AES-GCM) as credenciais de conectores guardadas no D1 | Base64 de 32 bytes |

O `wrangler.jsonc` declara os dois em `secrets.required`; o `wrangler deploy` recusa publicar se faltar algum ([Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)). Por isso, no primeiro deploy, mande os segredos junto com a versão. Gere um arquivo temporário fora do repositório, com permissão restrita:

```bash
umask 077
printf '{"JOB_TOKEN_SECRET":"%s","SECRETS_KEY":"%s"}' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > /tmp/puxibot-secrets.json
```

### 6. Deploy

```bash
npx wrangler deploy -c wrangler.production.jsonc --secrets-file /tmp/puxibot-secrets.json
```

```bash
rm /tmp/puxibot-secrets.json
```

O `--secrets-file` soma os segredos aos que já existem, sem apagar os outros. Nos deploys seguintes, não passe o arquivo:

```bash
npx wrangler deploy -c wrangler.production.jsonc
```

Antes do deploy, compile a interface (na raiz): `npm run build -w @puxibot/shared && npm run build -w @puxibot/web`. O Worker serve o que estiver em `apps/web/dist`.

Para trocar ou acrescentar um segredo depois, com o Worker já publicado:

```bash
npx wrangler secret put NOME_DO_SEGREDO -c wrangler.production.jsonc
```

O valor é pedido no terminal. Atenção: `wrangler secret put` cria uma versão nova do Worker e a publica na hora ([Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).

Para ver os nomes (nunca os valores) dos segredos definidos:

```bash
npx wrangler secret list -c wrangler.production.jsonc
```

## Variáveis e segredos opcionais

Sem eles, o recurso correspondente fica desligado, sem erro.

### `PUBLIC_URL`

Endereço público do hub, por exemplo `https://puxibot-hub.seu-subdominio.workers.dev`. É usado nos links de convite, de pareamento e nos avisos do Telegram. Vazio, o hub usa o endereço de cada requisição, o que funciona no navegador mas deixa os avisos do Telegram sem link. Com o script:

```bash
npm run deploy -- --public-url https://puxibot-hub.seu-subdominio.workers.dev
```

No caminho manual, preencha `vars.PUBLIC_URL` no `wrangler.production.jsonc` e publique de novo.

### Web Push (notificações no navegador e no celular)

Não testado com entrega real. Gere o par de chaves VAPID (na raiz):

```bash
npm run vapid -w @puxibot/hub
```

O comando imprime três linhas. Defina cada valor como segredo (em `apps/hub`):

```bash
npx wrangler secret put VAPID_PUBLIC_KEY -c wrangler.production.jsonc
```

```bash
npx wrangler secret put VAPID_PRIVATE_KEY -c wrangler.production.jsonc
```

```bash
npx wrangler secret put VAPID_SUBJECT -c wrangler.production.jsonc
```

`VAPID_SUBJECT` é um contato, no formato `mailto:voce@empresa.com`. No iPhone, o Web Push só funciona com o Puxibot adicionado à tela inicial.

### Telegram (avisos sem conteúdo)

Não testado com um bot real. O Telegram recebe só avisos como "Marcos respondeu em #dev" com o link, nunca o texto das mensagens.

1. Crie um bot com o @BotFather no Telegram e copie o token.
2. Defina os segredos `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (um texto aleatório que você inventa, só letras, números, `_` e `-`) e, opcionalmente, `TELEGRAM_BOT_USERNAME` (sem `@`), com `npx wrangler secret put` como acima.
3. Registre o webhook no Telegram, apontando para o hub. O hub não faz isso sozinho:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<PUBLIC_URL>/api/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>"
```

Depois, cada pessoa liga os avisos em **Configurações › Notificações** na interface.

### Roteador (binding `AI`)

O roteador usa um modelo pequeno do Workers AI (`@cf/meta/llama-3-8b-instruct`) para decidir qual agente responde a uma mensagem de canal sem `@menção`. Não testado com o Workers AI real.

1. O binding vai ligado no `npm run deploy` (ou `"ai": { "binding": "AI" }` no caminho manual). Ele fica fora do `wrangler.jsonc` versionado para o `wrangler dev` funcionar sem login.
2. Um admin liga o roteador por workspace em **Configurações › Workspace**.

Sem o binding, ou se o modelo falhar, o hub não roteia: só agentes mencionados, DMs e threads disparam trabalho.

## Domínio próprio

Por padrão o hub fica em `https://<nome-do-worker>.<seu-subdomínio>.workers.dev`. O subdomínio `workers.dev` da conta aparece e pode ser mudado no painel, em **Workers & Pages** ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)).

Para usar um domínio seu, ele precisa ser uma zona ativa na mesma conta Cloudflare, e o nome escolhido não pode ter um registro CNAME existente ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). Acrescente ao `apps/hub/wrangler.production.jsonc`:

```jsonc
"routes": [{ "pattern": "puxibot.suaempresa.com", "custom_domain": true }],
"workers_dev": true,
```

Com `routes` e sem `workers_dev`, o endereço `workers.dev` é desligado no deploy seguinte; o `"workers_dev": true` mantém os dois. O script preserva `routes` e `workers_dev` entre deploys. Depois publique com o novo endereço público:

```bash
npm run deploy -- --public-url https://puxibot.suaempresa.com
```

Se os runners já estavam pareados pelo endereço antigo e ele continuar no ar, nada muda para eles. Se você desligar o `workers.dev`, refaça o `puxibot login` em cada computador com o endereço novo.

Também dá para acrescentar o domínio pelo painel (**Settings › Domains & Routes › Add › Custom Domain**), mas a Cloudflare avisa que o Wrangler pode sobrescrever rotas definidas no painel; prefira o arquivo.

## Cloudflare Access na frente (opcional)

O hub tem login próprio (e-mail e senha). Só a primeira conta é criada sem convite, em `/cadastro`: crie a sua logo depois do deploy, porque até lá qualquer pessoa com o endereço pode ser essa primeira. Depois disso, novas pessoas só entram por link de convite. Para liberar o cadastro a qualquer pessoa com o endereço, acrescente `"OPEN_SIGNUP": "true"` em `vars` no `apps/hub/wrangler.jsonc` e rode `npm run deploy` de novo; nesse caso, quem se cadastra não enxerga os workspaces dos outros, mas consome a cota da sua conta Cloudflare. Para uma camada a mais, ponha o Cloudflare Access (camada de login da Cloudflare) na frente do hub.

- O plano Zero Trust Free cobre até 50 usuários, a US$ 0 ([planos Zero Trust](https://www.cloudflare.com/plans/zero-trust-services/)); o cadastro no Zero Trust pede uma forma de pagamento ([configuração do Cloudflare One](https://developers.cloudflare.com/cloudflare-one/setup/)).
- O guia de aplicações públicas do Access cobre nomes em domínios da sua conta ([self-hosted public app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)); por isso, use um domínio próprio. Proteger o endereço `workers.dev` não foi conferido.
- **Cuidado com o runner**: ele fala com o hub por HTTP e WebSocket, sem navegador, e não sabe passar pelo login do Access. Proteger o hub inteiro desconecta os runners. Uma opção é proteger tudo menos os caminhos que o runner usa (`/api/runner/*`, `/api/workspaces/*/runner`, `/api/workspaces/*/runners/*`, `/api/tool/*` e `/api/me`), que já exigem token, e deixar o pareamento ser aprovado pela interface protegida. Essa combinação não foi testada.

## Atualizar para uma versão nova

```bash
git pull
```

```bash
npm install
```

```bash
npm run deploy
```

O script aplica as migrações novas do banco antes de publicar o código novo. Se uma migração falhar, ele para sem publicar.

Para voltar o código a uma versão anterior, existe `npx wrangler rollback`, mas ele não desfaz migrações do banco nem dados ([rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). Antes de atualizar, você pode exportar o banco:

```bash
npx wrangler d1 export puxibot --remote --output backup.sql -c wrangler.production.jsonc
```

O D1 também guarda um histórico para restauração (Time Travel): 7 dias no plano gratuito e 30 no pago ([limites do D1](https://developers.cloudflare.com/d1/platform/limits/)); veja `npx wrangler d1 time-travel --help`.

## Cabeçalhos de segurança da interface

Os arquivos da interface (static assets) são servidos direto pela Cloudflare, sem passar pelo código do Worker; por isso, os cabeçalhos de segurança deles vêm do arquivo `apps/web/public/_headers`, que vai para `apps/web/dist/_headers` no build ([cabeçalhos de static assets](https://developers.cloudflare.com/workers/static-assets/headers/)). Ele define a CSP (sem script inline: o tema e a tela offline carregam `/theme.js` e `/offline.js`), `X-Content-Type-Options`, `Referrer-Policy` e `X-Frame-Options`. As respostas de `/api/*` saem do Worker e têm cabeçalhos próprios (`apps/hub/src/http/security.ts`).

Se você mudar a interface: o build falha se aparecer um `<script>` inline sem o hash correspondente em `script-src`, ou um atributo como `onclick=`. O `_headers` foi conferido localmente com `wrangler dev` (inclusive no fallback de SPA); no deploy real, confira com `curl -I https://<seu-hub>/`.

## Logs

```bash
npx wrangler tail -c wrangler.production.jsonc
```

Os logs e traces do Worker também ficam no painel (o `wrangler.jsonc` liga `observability`).

## Custos e limites

O hub não executa IA, então o consumo é de requisições, banco e arquivos. Tabela do plano gratuito (Workers Free), conferida em 21/11/2026:

| Produto | Plano gratuito | O que consome no Puxibot | Fonte |
|---|---|---|---|
| Workers: requisições | 100.000 por dia | Cada chamada a `/api/*`. Arquivos da interface (static assets) são gratuitos e ilimitados | [limites](https://developers.cloudflare.com/workers/platform/limits/), [static assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| Workers: CPU | 10 ms por requisição | Ver "Pontos de atenção" | [limites](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers: subrequisições | 50 por requisição | Consultas ao D1, chamadas ao R2, envios de push | [limites](https://developers.cloudflare.com/workers/platform/limits/) |
| Cron Triggers | 5 por conta | O hub usa 1 | [limites](https://developers.cloudflare.com/workers/platform/limits/) |
| Durable Objects | 100.000 requisições por dia, 13.000 GB-s por dia, 5 milhões de linhas lidas e 100.000 escritas por dia, 5 GB no total | Tempo real e entrega dos jobs. Mensagens WebSocket recebidas contam 1 requisição a cada 20; com hibernação, objeto ocioso não conta duração | [preços do DO](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Durable Objects: armazenamento | Só a classe SQLite (a que o hub usa), 1 GB por objeto, 5 GB por conta | Quase nada: o hub guarda no objeto só o id do workspace e o alarme; mensagens e jobs ficam no D1 | [limites do DO](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| D1 | 5 milhões de linhas lidas e 100.000 escritas por dia, 5 GB no total, 500 MB por banco, 50 consultas por requisição | Quase toda rota | [preços do D1](https://developers.cloudflare.com/d1/platform/pricing/), [limites do D1](https://developers.cloudflare.com/d1/platform/limits/) |
| R2 | 10 GB-mês, 1 milhão de operações classe A e 10 milhões classe B por mês, sem custo de saída | Drive e anexos (até 25 MB por arquivo, limite do hub) | [preços do R2](https://developers.cloudflare.com/r2/pricing/) |
| Workers AI | 10.000 neurons por dia | Só o roteador. O modelo custa 25.608 neurons por milhão de tokens de entrada e 75.147 por milhão de saída | [preços do Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) |

Quando um limite diário do plano gratuito estoura, as operações daquele tipo passam a falhar com erro até 00:00 UTC (D1, Durable Objects e Workers AI dizem isso explicitamente nas páginas acima). Pela página de static assets, no plano gratuito as requisições que passam pelo Worker (no hub, `/api/*`) recebem erro 429 depois do limite diário, enquanto os arquivos da interface continuam sendo servidos.

O plano pago (Workers Paid) custa no mínimo US$ 5 por mês por conta e inclui 10 milhões de requisições e 30 milhões de ms de CPU por mês, com o limite de CPU por requisição subindo para 30 s por padrão ([preços do Workers](https://developers.cloudflare.com/workers/platform/pricing/)).

### O plano gratuito é suficiente?

Pelos números da documentação, um time pequeno (algumas pessoas, poucas centenas de mensagens por dia) fica bem abaixo das cotas diárias de requisições, banco e arquivos. Todos os produtos que o hub usa existem no plano gratuito, inclusive Durable Objects com SQLite. Isso não foi medido com o hub em uso real.

Pontos de atenção que podem exigir o plano pago:

- **CPU de 10 ms por requisição.** O login e o cadastro calculam o hash da senha com PBKDF2 de 100.000 iterações. Num deploy real no plano gratuito, o login respondeu em cerca de 0,5 s sem erro de limite, em poucas tentativas; não é garantia sob carga. Se o login falhar no plano gratuito com erro de limite de recursos, essa é a causa provável e o plano pago resolve.
- **50 subrequisições por requisição.** Rotas que fazem muitas consultas ao D1 ou que mandam push para muitos navegadores de uma vez podem passar disso num workspace grande. Não medido.
- **Cadastro**: fechado depois da primeira conta. Se você abrir com `OPEN_SIGNUP`, alguém de fora pode consumir sua cota criando contas (até 20 workspaces por pessoa e 10 cadastros por IP por hora). Veja o Access acima e [Antes de divulgar o endereço do hub](instalacao.md#antes-de-divulgar-o-endereço-do-hub).

## Remover tudo

Isto apaga os dados do time de forma definitiva. Exporte o banco antes, se quiser guardar (veja "Atualizar"). Em `apps/hub`:

```bash
npx wrangler delete -c wrangler.production.jsonc
```

```bash
npx wrangler d1 delete puxibot
```

Para o bucket (se o comando recusar porque o bucket tem arquivos, esvazie-o pelo painel do R2 antes):

```bash
npx wrangler r2 bucket delete puxibot-files
```
