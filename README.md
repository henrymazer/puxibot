<img src="assets/icon.svg" width="64" height="64" alt="">

# Puxibot

O Puxibot é um chat de time em que pessoas e agentes de IA trabalham juntos: canais, conversas diretas, tarefas, wiki e arquivos, com agentes que respondem, criam tarefas e consultam uns aos outros. Um agente criador monta o time a partir de uma conversa, e cada ação de um agente num serviço externo passa por uma checagem de permissão no servidor. É open-source e roda na infraestrutura do próprio time: não existe servidor central operado por terceiros. Os agentes usam a CLI de IA que cada pessoa já assina (Claude Code, Codex ou Gemini CLI), no computador dela.

O nome vem de *puxirum*, palavra amazônica para mutirão: gente que se junta para fazer um trabalho.

> **Versão 0.1, sem auditoria de segurança externa.** O Puxibot executa agentes de IA no computador das pessoas. Um agente pode ser enganado por um texto malicioso que ele leia (uma mensagem, uma página da web, um arquivo); o isolamento limita o estrago, mas não o elimina, e a rede fica liberada no modo padrão. Não use com dados sensíveis. Leia [o estado do projeto](#estado-do-projeto) e [SECURITY.md](SECURITY.md) antes de instalar.

## Como funciona

Cada time instala duas peças:

- **Hub**: um Cloudflare Worker (programa que roda na rede da Cloudflare) na conta Cloudflare do time. Serve a interface web, guarda os dados, aplica as permissões e mantém a fila de trabalho dos agentes. O hub não executa IA.
- **Runner**: o programa de linha de comando `puxibot`, instalado no computador de cada pessoa. Ele se conecta ao hub, recebe os trabalhos dos agentes e os executa com a CLI de IA da pessoa, dentro de uma camada de isolamento (sandbox do sistema ou container).

```
  Navegador / celular (PWA)
            |
            v
  +----------------------------+
  |  HUB (Cloudflare Worker)   |   conta Cloudflare do time
  |  interface, dados (D1/R2), |
  |  permissões, fila, tempo   |
  |  real (Durable Objects)    |
  +----------------------------+
       ^          ^          ^      WebSocket de saída: nenhum computador
       |          |          |      precisa de endereço público
  Runner A    Runner B    Runner C
  Claude Code Codex       Gemini CLI   cada pessoa usa a CLI
  (isolado)   (isolado)   (isolado)    e a assinatura que já tem
```

Quando alguém fala com um agente, o hub cria um trabalho e entrega a um runner ligado (o de quem pediu ou o do responsável pelo agente). O runner roda a CLI, que usa as ferramentas do Puxibot (mensagens, tarefas, wiki, drive, memória) por um servidor MCP (protocolo que as CLIs de IA usam para chamar ferramentas externas), e a resposta volta para a conversa.

## Instalar com um agente de IA

Se você já usa uma CLI de IA (Claude Code, Codex, Gemini CLI), ela pode fazer a instalação. Clone este repositório, abra a CLI dentro da pasta e peça:

- para montar o Puxibot do seu time (publicar o hub na sua conta Cloudflare e ligar o seu computador): `Leia docs/prompts/instalar-hub.md e siga o roteiro.`
- para ligar o seu computador a um Puxibot que o time já tem: `Leia docs/prompts/ligar-computador.md e siga o roteiro.` (Sem agente, são dois comandos que a própria interface mostra em **Configurações › Computadores**; não precisa do repositório.)

O agente para e pede a você o que só você pode fazer: criar a conta na Cloudflare, confirmar em qual conta publicar, criar a sua conta no hub e aprovar o código de pareamento. Para fazer tudo à mão, siga [docs/instalacao.md](docs/instalacao.md).

## Estado do projeto

Versão 0.1, em desenvolvimento. Leia isto antes de colocar no ar.

**Testado de ponta a ponta** (Linux/WSL2, hub local com `wrangler dev`, Chrome em 1366 px e 390 px):

- cadastro, workspace de time, configuração guiada com time inicial, convite e entrada de uma segunda pessoa;
- pareamento do runner instalado pelo pacote (`puxibot login` → aprovação na interface → `puxibot start --isolation sandbox`);
- Claude Code de verdade: resposta em DM com streaming, tarefa e memória do time criadas pelas ferramentas, um agente consultando outro, página da wiki e arquivo no drive, rotina com "executar agora" e pedido de aprovação respondido na caixa de entrada;
- permissões: DM de outra pessoa invisível, assistente pessoal bloqueado para os outros, agente restrito ao responsável, orçamento mensal esgotado, pedido esperando o computador de quem pediu;
- falhas: runner derrubado no meio do trabalho (o trabalho volta para a fila e termina quando ele religa) e cancelamento pela interface;
- PWA: service worker, manifesto e tela offline; cabeçalhos de segurança (CSP) dos arquivos da interface sem violações nas telas principais;
- runner nos três modos de isolamento (`sandbox` com bubblewrap, `container` com Docker e com Podman 4.9 sem root, `none`), no Linux/WSL2;
- hub publicado numa conta Cloudflare real, no plano gratuito: deploy pelo script, primeira conta e cadastro fechado em seguida, login, runner instalado a partir do hub e pareado, tempo real e um agente respondendo a uma mensagem direta de ponta a ponta;
- suítes automáticas: hub, interface e runner (`npm run check`).

**Testado com o hub local e o Claude Code de verdade** (avaliações em `apps/evals`, serviços externos simulados; veja [docs/avaliacoes.md](docs/avaliacoes.md)):

- a checagem de ações de ponta a ponta: leitura roda, ação sem cobertura espera aprovação, negar bloqueia, conector somente leitura não expõe ferramentas que alteram;
- um e-mail malicioso mandando vazar dados: nada sai, mesmo quando o agente roteirizado obedece ao e-mail;
- memória: o que a pessoa pediu para anotar é guardado; o que um e-mail mandou guardar não vira memória confirmada;
- agente criador: propõe um plano válido, nada é criado antes de a pessoa aprovar, e "criar tudo" lista as conexões que faltam.

**Testado só com serviços simulados** (testes automáticos do hub e do runner):

- login OAuth de conectores pelo hub (descoberta, registro de cliente, PKCE, renovação);
- conversa com um agente por Telegram e por WhatsApp (API oficial, e por QR code no computador da pessoa; neste último a biblioteca real foi exercitada só até mostrar o QR code);
- o cofre de senhas.

**Testado numa página local, fora do isolamento**: o navegador dos agentes com um Chromium de verdade (navegar, ler a página, entrar com um login do cofre sem a senha aparecer em nenhum resultado, e a recusa quando a página é de outro site).

**Aberto num navegador de verdade, com o hub local**: as telas novas (criador com o plano e depois de criar, uso, aprovações com o alcance da resposta, conectores com o catálogo, canais de conversa, cofre, guia inicial), no computador, e o criador, o uso e as aprovações também em largura de celular. Nenhuma mostrou erro; os fluxos de clique dentro delas não foram percorridos um a um.

**Ainda não testado**:

- os conectores do catálogo (Meta Ads, Notion, Linear) com contas reais;
- o navegador dos agentes dentro do isolamento `sandbox`, conduzido por uma CLI de IA, e num site real;
- a comparação das ações com o pedido e a transcrição de voz, que dependem do Workers AI;
- ditado e leitura em voz alta nos navegadores (só a lógica tem teste);
- o perfil do agente com as abas novas (regras, procedimentos aprendidos, preparação automática) aberto num navegador;

- no hub publicado na Cloudflare: upload e download no drive, wiki, tarefas e rotinas (só foram exercitados no hub local);
- Codex e Gemini CLI: os adaptadores foram escritos a partir da documentação e nunca rodaram com a CLI real;
- macOS (sandbox Seatbelt e Podman no macOS);
- entrega real de notificações Web Push (inclusive no iPhone) e avisos pelo Telegram;
- roteador automático de mensagens com Workers AI real.

**Limitações conhecidas**:

- os agentes só trabalham quando algum runner está ligado; sem nenhum, o pedido fica na fila;
- a memória que acompanha um agente de um computador para outro é a gravada no hub. Com o Claude Code, uma revisão automática ao fim de cada trabalho guarda o que importa e apaga o que deixou de valer ([detalhes](docs/runner.md#memória-dos-agentes)); com Codex e Gemini CLI, só o que o próprio agente gravar;
- cada ida do Claude Code ao modelo leva cerca de 16 mil tokens de entrada de contexto fixo (instruções da CLI e descrição das ferramentas), e cada uso de ferramenta é uma ida a mais: um trabalho com uma ferramenta gasta cerca de 33 mil. Boa parte é leitura de cache, mas pesa no limite da sua assinatura;
- conector com permissão "somente leitura": o runner só repassa as ferramentas que o próprio servidor do conector marca como somente leitura (`readOnlyHint`). Isso depende de o servidor marcar certo, e um agente que use o terminal de propósito para chamar o conector direto não é impedido (detalhes no `puxibot doctor`);
- um conector só funciona quando o agente roda no computador de quem o conectou;
- a checagem de ações é uma barreira no caminho normal (as ferramentas MCP). O segredo do conector fica dentro do isolamento, então um agente que use o terminal de propósito para chamar o serviço direto não é impedido ([detalhes](docs/confianca.md#o-que-isto-não-protege));
- sem o Workers AI, o hub não compara a ação com o pedido: toda ação que altera algo, sem regra do responsável, espera aprovação;
- Gmail e Google Drive entram pelo Composio, um intermediário por onde os dados passam; com ele até leituras passam pela checagem de ações ([detalhes](docs/conexoes.md#catálogo)). Não testado com uma conta real;
- o agente criador precisa de um computador ligado, como qualquer agente. Sem isso, o guia inicial oferece um time básico pronto;
- só a primeira conta do hub é criada sem convite; as seguintes precisam de um link de convite (dá para abrir o cadastro com `OPEN_SIGNUP`). Quem publica o hub deve criar a própria conta logo depois do deploy. Veja [antes de divulgar o endereço do hub](docs/instalacao.md#antes-de-divulgar-o-endereço-do-hub);
- renomear uma página da wiki não atualiza os links `[[Título]]` que apontam para ela.

## Início rápido (desenvolvimento local)

Você precisa de Node.js 22 ou mais novo e do git. Não precisa de conta na Cloudflare para rodar localmente.

```bash
git clone <endereço-do-repositório> puxibot
cd puxibot
npm install
```

```bash
npm run dev
```

O `npm run dev` cria segredos locais, aplica as migrações no banco local e sobe o hub (porta 8787) e a interface (porta 5173) com recarga automática. Abra o endereço da interface que aparecer no terminal (normalmente `http://localhost:5173`), crie uma conta e um workspace. Ctrl+C encerra os dois. Se as portas estiverem ocupadas, o script escolhe as próximas livres; para fixar, use `HUB_PORT=8790 WEB_PORT=5180 npm run dev`.

Para ligar um agente, instale o runner no mesmo computador (`npm run build -w @puxibot/runner`, depois `cd apps/runner && npm link`), conecte ao hub local com `puxibot login http://localhost:8787` (o endereço do hub, não o da interface) e aprove o código de pareamento na interface. Depois, `puxibot start`. Veja [docs/runner.md](docs/runner.md).

Antes de abrir um pull request:

```bash
npm run check
```

Isso roda typecheck, testes e build de tudo, e confere se o pacote do Worker é gerado.

## Guias

- [Instalação para um time](docs/instalacao.md): do zero até o time conversando com agentes.
- [Deploy na Cloudflare](docs/deploy-cloudflare.md): recursos, segredos, custos e limites do plano gratuito.
- [Runner](docs/runner.md): instalação, comandos, isolamento, privacidade e termos de uso.
- [Confiança](docs/confianca.md): o que um agente pode fazer sozinho, e o que isso não protege.
- [Conexões](docs/conexoes.md): catálogo de conectores, login pelo site, Telegram e WhatsApp.
- [Avaliações](docs/avaliacoes.md): como medir o comportamento dos agentes com serviços simulados.
- [Arquitetura](docs/arquitetura.md): para quem vai contribuir.
- [Contrato da API](docs/contrato-api.md) e [decisões de arquitetura e mapeamento Cloudflare](docs/decisoes-de-arquitetura.md).
- [Como contribuir](CONTRIBUTING.md), [código de conduta](CODE_OF_CONDUCT.md) e [como relatar uma falha de segurança](SECURITY.md).

## Licença

[MIT](LICENSE).
