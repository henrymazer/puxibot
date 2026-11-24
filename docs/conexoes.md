# Conexões: ligar os agentes a serviços externos

Um agente usa um serviço externo por um **conector**: um servidor MCP (o protocolo que as CLIs de IA usam para chamar ferramentas). Há três jeitos de criar um, todos em **Configurações › Conectores**:

| Jeito | Para quê | O que a pessoa faz |
|---|---|---|
| App do catálogo | Serviços que já vêm configurados | Entra na conta, ou cola um token |
| Outro serviço, com login pelo site | Qualquer servidor MCP público que siga o login padrão do protocolo | Informa o endereço e entra na conta |
| Outro serviço, com token ou comando local | Qualquer servidor MCP | Informa o endereço (ou o comando) e os segredos |

Quem conecta vira o dono do conector: só essa pessoa concede acesso a ele, e ele só funciona quando o agente roda no computador dela. Toda chamada passa pela [checagem de ações](confianca.md).

## Catálogo

| App | Endereço | Como conecta | Situação |
|---|---|---|---|
| Meta Ads | `https://mcp.facebook.com/ads` | Token de acesso, ou login com o ID do seu app da Meta | Não testado com uma conta real |
| Notion | `https://mcp.notion.com/mcp` | Login pelo site | Não testado com uma conta real |
| Linear | `https://mcp.linear.app/mcp` | Login pelo site | Não testado com uma conta real |
| Gmail e Google Drive (Composio) | `https://connect.composio.dev/mcp` | Login pelo site, na conta do Composio | Início do login testado contra o servidor real (24/11/2026); uso com uma conta não testado |

Os endereços de Meta Ads, Notion e Linear são os servidores oficiais de cada empresa; o do Composio é um intermediário (veja abaixo). O fluxo de login foi testado de ponta a ponta contra um serviço simulado, não contra os serviços reais.

**Meta Ads com token.** O jeito mais simples: no Gerenciador de Negócios, crie um usuário do sistema com função Funcionário, dê acesso à conta de anúncios e gere um token com `ads_mcp_management` e `ads_read` (leitura) ou `ads_management` (criar e editar). O token do Explorador da Graph API também funciona, mas expira em poucas horas. Tokens de usuário do sistema com função Admin não são aceitos pela Meta.

**Gmail e Google Drive pelo Composio.** O Google não tem um servidor MCP que um time ligue sem criar um projeto no Google Cloud; por isso o catálogo usa o [Composio](https://composio.dev) como intermediário. Como funciona:

1. Em Configurações › Conectores, conecte "Gmail e Google Drive (Composio)". O login é o padrão do MCP: você entra (ou cria a conta gratuita) no Composio e nenhuma chave é colada.
2. Peça ao agente para ligar o Gmail ou o Drive. Ele devolve um link do Composio; você abre e autoriza a conta do Google.

O que saber antes de usar:

- **Os dados passam pelo Composio.** E-mails e arquivos que o agente lê ou envia trafegam pelos servidores dele.
- **O plano gratuito tem limite mensal de chamadas** (10.000 no plano pessoal quando este guia foi escrito). Confira em [composio.dev/pricing](https://composio.dev/pricing).
- **O servidor oferece poucas ferramentas genéricas** que buscam e executam qualquer ação, em vez de uma ferramenta por ação. O Puxibot não consegue saber sozinho se uma execução só lê; por isso, com o Composio, até leituras passam pela checagem de ações (pedido da pessoa, regra ou aprovação), e o nível "somente leitura" pode não mostrar nenhuma ferramenta. Use "leitura e escrita" e não crie regra de "sempre" para a ferramenta de execução: ela liberaria também enviar e apagar.
- A conta do Composio é pessoal, e o conector só funciona no computador de quem conectou, como os outros.

## Login pelo site (OAuth)

O hub faz o login padrão do MCP: descobre o servidor de autorização do serviço, registra-se como cliente (ou usa o ID do app que você informar), abre a tela de consentimento do serviço e, na volta, guarda o acesso cifrado.

- O acesso e a renovação ficam cifrados no hub (`SECRETS_KEY`). O token de renovação nunca sai do hub.
- A cada trabalho, o runner recebe só um token de acesso recém-conferido. Se faltar menos de 35 minutos para vencer, o hub renova antes.
- Se a renovação for recusada, o conector fica marcado "Login expirou", sai dos trabalhos e a tela mostra **Entrar de novo**.
- O login vale uma vez, por 10 minutos, e só para quem o começou (a sessão do navegador que volta precisa ser a mesma).
- O hub só fala com endereços públicos por HTTPS em qualquer passo do login, inclusive os que o próprio serviço indica.

O endereço de retorno é `<PUBLIC_URL>/api/oauth/callback`. Serviços que pedem um app registrado por você (como a Meta) precisam desse endereço cadastrado no app; a tela mostra o valor para copiar. Configure `PUBLIC_URL` no hub antes de usar o login pelo site.

## Acrescentar um app ao catálogo

Cada app é uma pasta em `packages/shared/apps/<id>/`, no formato [Agent Plugins 1.0.0](https://agent-plugins.org/specification), o mesmo que o Nod usa:

```
packages/shared/apps/meta-ads/
  plugin.json          manifesto: nome, versão, descrição, autor
  mcp.json             um servidor, tipo streamable-http, endereço HTTPS público
  io.puxibot/app.json  nome de exibição, exemplos, requisitos, limites, forma de conexão, dicas
```

`io.puxibot/app.json`:

| Campo | Regra |
|---|---|
| `displayName` | Uma linha, até 80 caracteres |
| `categories` | Até 10 |
| `prompts` | De 2 a 4 pedidos de exemplo, concretos |
| `requirements` | De 1 a 8: conta, plano, permissões |
| `limitations` | De 1 a 8: o que não faz ou faz com restrição |
| `connection` | `{ "type": "mcp", "server": "<nome em mcp.json>", "authentication": ["oauth2" \| "bearer" \| "x-api-key"], "scopes"?, "clientIdRequired"?, "apiKeyHeader"? }` |
| `hints` | Uma linha por campo do formulário (`token`, `clientId`), dizendo onde a pessoa acha o valor |

Depois de criar a pasta, importe os três arquivos em `packages/shared/src/catalog.ts` e rode `npm test -w @puxibot/hub`. O teste recusa campos fora do perfil, endereço que não seja HTTPS público e exemplos de menos.

Antes de propor um app, confira na documentação oficial do serviço o endereço, a forma de autenticação e uma operação de leitura, e teste com uma conta real: conectar, reconectar, acesso negado e token vencido. Diga no pull request o que não foi testado.

## Conversar com um agente por Telegram ou WhatsApp

Em **Configurações › Canais de conversa**, cada pessoa liga a própria conta a um agente. A mensagem enviada vira uma mensagem dela na DM com o agente, e a resposta volta pelo mesmo canal. É a mesma conversa da interface.

- Só a conta vinculada fala com o agente. No Telegram, só em conversa privada com o bot.
- Aprovações, logins e conexões continuam na interface, nunca no aplicativo de conversa.
- Avisos de falha não levam o detalhe do erro para fora.

A configuração do bot do Telegram e da API do WhatsApp está em [deploy-cloudflare.md](deploy-cloudflare.md#telegram). Esse caminho do WhatsApp usa a API oficial da Meta (Cloud API) e não foi testado com uma conta real.

### WhatsApp pelo seu computador (QR code)

Para uso pessoal existe um segundo caminho, igual ao do [Nod](https://github.com/n8n-io/nod): o WhatsApp é vinculado por QR code no computador onde o seu runner roda, sem a API oficial e sem configurar nada no hub.

```bash
puxibot whatsapp conectar --agente assistente
```

O comando mostra o aviso de risco, instala a biblioteca na primeira vez e desenha o QR code no terminal. No celular: WhatsApp › Configurações › Dispositivos conectados › Conectar dispositivo. Depois reinicie o `puxibot start`.

Há dois modos:

| Modo | Como ligar | Por onde você escreve |
|---|---|---|
| Seu próprio número (padrão) | Leia o QR com o seu celular | Na conversa "Mensagem para você mesmo" |
| Número separado só para o agente | `--numero-separado --meu-numero 5511999990000`, lendo o QR com o celular do outro número | Do seu número para o número do agente |

O que o runner faz e não faz:

- **Só mensagens suas chegam ao agente.** Grupos, status, canais, outras conversas e tudo que é anterior ao vínculo são ignorados antes de virar pedido.
- **O agente só escreve para você.** Não há ferramenta para ele mandar WhatsApp a outra pessoa.
- **Só texto.** Áudio, foto e arquivo recebem um aviso curto.
- **Precisa do computador ligado** com o runner rodando. Com ele desligado, a mensagem espera e a resposta fica na conversa da interface.
- **As chaves do aparelho ficam em `~/.puxibot/whatsapp/`**, em arquivos que só o seu usuário lê. Essa pasta fica escondida dos agentes em todos os modos de isolamento. Elas não são cifradas: quem tem acesso ao seu usuário no computador tem acesso ao vínculo.
- **Quem você é vem do runner**, não do número: o hub recebe a mensagem pela conexão autenticada do seu runner e confere se você pode falar com o agente escolhido.
- `puxibot whatsapp desconectar` avisa o WhatsApp e apaga as chaves; `puxibot whatsapp status` mostra o estado.

Riscos, os mesmos que o Nod avisa:

- Usa o Baileys, um cliente **não oficial**. Há um risco pequeno de o WhatsApp restringir ou banir a conta, e uma atualização dele pode quebrar a conexão por um tempo. Confira os termos do WhatsApp antes.
- É para poucas mensagens entre você e o seu agente. Para atender clientes ou enviar em volume, use a API oficial.
- A biblioteca é baixada do npm numa versão fixa (`@whiskeysockets/baileys@7.0.0-rc14`, a mesma do Nod), sem rodar scripts de instalação; as dependências dela seguem as faixas de versão que ela declara.

Situação: testado com um soquete simulado (regras de quem pode escrever, reconexão, envio) e, com a biblioteca real, até o QR code aparecer no terminal. Vincular uma conta e trocar mensagens de verdade não foi testado.
