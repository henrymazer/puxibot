# Decisões de arquitetura e mapeamento Cloudflare

Por que o Puxibot tem duas peças (hub e runner), o que cada uma faz e que recurso da Cloudflare atende cada necessidade do hub. Para a visão técnica do código, veja [arquitetura.md](arquitetura.md).

## 1. Arquitetura escolhida

Produto open-source, sem servidor operado por nós. Cada time instala duas peças:

- **Hub**: servidor central leve, na conta Cloudflare do próprio time. Guarda os dados, impõe permissões, distribui eventos em tempo real e serve a interface web. Não executa IA.
- **Runner**: programa instalado no computador de cada pessoa. Executa os agentes usando a CLI de IA que ela já tem instalada e logada (Claude Code, Codex, Gemini CLI), com a assinatura dela.

```
 Celular (PWA)      Navegador
       \               /
        \             /
     ┌───────────────────┐
     │        HUB        │  Cloudflare, conta do time
     │ interface, dados, │
     │ permissões, fila  │
     └───────────────────┘
        /       |       \        WebSocket de saída
   Runner A  Runner B  Runner C  (nenhum precisa de endereço público)
   Claude    Codex     Gemini    (cada pessoa usa a CLI
   Code                CLI        e a assinatura que tem)
```

Decisões tomadas:

- O agente é dado no hub (instruções, skills, memória, permissões). Qualquer runner autorizado consegue executá-lo.
- Nenhuma máquina acessa o banco direto; tudo passa pela API do hub.
- O hub é a fonte da verdade. O runner não mantém cópia editável dos dados, então não há sincronização nem conflito para resolver.
- Celular usa a interface web do hub instalada como PWA. Sem app nativo e sem Cloudflare Tunnel.
- Telegram é plugin opcional, só para avisos sem conteúdo ("Marcos respondeu em #dev" com link).

## 2. Hub: mapeamento para a Cloudflare

| Necessidade | Produto Cloudflare | Como usar |
|---|---|---|
| Interface web e API | Workers (com static assets) | Um Worker serve o PWA e as rotas de API. |
| Tempo real | Durable Objects | Um DO por canal/DM com WebSockets hibernáveis, para navegadores e runners. |
| Fila de trabalho dos agentes | Durable Objects | Um DO por workspace entrega cada trabalho a um único runner e controla o prazo de execução. |
| Dados relacionais | D1 | Usuários, membros, papéis, canais, agentes, tarefas, permissões, orçamentos, wiki. |
| Histórico de mensagens | SQLite do Durable Object | Cada canal guarda as próprias mensagens. |
| Arquivos do drive | R2 | Objetos; metadados no D1. |
| Busca | D1 (busca textual) | Mensagens, wiki e tarefas. Vectorize entra depois, se a busca semântica fizer falta. |
| Rotinas agendadas | Alarmes do Durable Object | O hub dispara no horário e enfileira o trabalho para o runner certo. |
| Roteador de mensagens | Workers AI | Modelo pequeno decide qual agente responde. Entra depois da menção explícita. |
| Credenciais de conectores | D1 com criptografia, chave em segredo do Worker | Entregues só ao runner autorizado, no momento da execução. |
| Convites e link de login | Email Service | Opcional; convite por link copiado funciona sem e-mail. |
| Notificações no celular | Web Push enviado pelo Worker | Sem produto extra. |
| Camada extra de login | Access | Opcional, para o time que quiser. |
| Instalação | Wrangler | Um comando cria os recursos e publica o hub. |

Meta: o hub caber no plano gratuito da Cloudflare, já que não roda IA. Os limites atuais de cada produto (Workers, Durable Objects, D1, R2, Workers AI, Email Service) precisam ser conferidos antes de prometer isso na documentação.

## 3. Runner: o que roda na máquina de cada pessoa

- Conecta ao hub por WebSocket de saída e se identifica como a pessoa logada.
- Recebe trabalhos, executa e devolve o resultado em streaming para o canal.
- Ferramentas nativas (mensagens, tarefas, wiki, drive, memória) são expostas ao agente como um servidor MCP que fala com o hub.
- Conectores externos (GitHub, e-mail etc.) são MCPs liberados conforme a governança do agente.
- O que for resultado sobe para o drive no hub; o resto da pasta de trabalho é descartável.
- Extração de memória acontece no runner, ao fim da execução, e é gravada no hub.

### 3.1 Adaptador de CLI

Um adaptador por ferramenta. Cada um sabe:

- iniciar a CLI em modo não interativo, com o login que a pessoa já tem;
- entregar as instruções do agente no formato que a CLI espera;
- registrar o servidor MCP das ferramentas nativas;
- ler a resposta em streaming e devolver ao hub num formato único;
- retomar uma sessão anterior, quando a CLI permitir.

Adaptadores previstos: Claude Code (primeiro), Codex (assinatura ChatGPT), Gemini CLI. O segundo adaptador serve de teste para saber se a interface ficou genérica.

### 3.2 Isolamento

Aplicado pelo runner em volta de qualquer CLI, com as mesmas regras para todas: o agente só alcança a própria pasta de trabalho e uma lista de endereços de rede permitidos.

| Modo | Como funciona | Requisito |
|---|---|---|
| Padrão: sandbox do sistema | O runner envolve o processo da CLI com o isolamento nativo (Seatbelt no Mac, bubblewrap no Linux e no WSL2). | Nenhuma instalação extra. No Windows, WSL2. |
| Opcional: container | Cada agente em execução sobe um container, que para ao terminar. Ambiente limpo e isolamento mais forte. | Qualquer runtime compatível com a API do Docker. Recomendado para quem não tem nenhum: Podman (open-source, Mac/Windows/Linux). |

O sandbox próprio de cada CLI não é usado como camada de segurança do produto, porque cada um se comporta e se configura de um jeito.

A validar na construção:

- liberar a pasta de credenciais de cada CLI só para leitura dentro do sandbox;
- se o sandbox próprio da CLI conflita com o do runner e precisa ser desligado;
- diferenças de formato de saída e de retomada de sessão entre as CLIs.

## 4. Quem executa cada trabalho

| Origem do trabalho | Runner escolhido |
|---|---|
| Pedido de uma pessoa com runner online | O da própria pessoa, com a assinatura dela. |
| Pedido de uma pessoa sem runner online (ex.: celular) | O do responsável pelo agente. |
| Rotina agendada | O do responsável pelo agente. |
| Um agente chamando outro | O mesmo runner que está executando o primeiro. |
| Nenhum runner elegível online | O trabalho fica na fila e a interface avisa. Executa quando um voltar. |

Um trabalho é entregue a um runner por vez, com prazo. Se o runner cair, o trabalho volta para a fila.

## 5. Escopo

Entra: workspace, papéis, canais, DMs, agentes com instruções e memória, governança, tarefas, wiki, drive, rotinas, assistente pessoal, conectores MCP, servidor MCP próprio.

Consequências de os agentes rodarem no computador das pessoas:

- Cada agente tem uma pasta de trabalho isolada na máquina de quem executa, e só trabalha com algum runner ligado.
- O orçamento por agente conta execuções e tokens por pessoa, já que cada um usa a própria assinatura.
- Cada pessoa usa a CLI que já assina. Um mesmo agente pode rodar em CLIs diferentes conforme quem executa.

## 6. Pontos de atenção

- **Termos da assinatura**: o runner usa a CLI da própria pessoa, na máquina dela. Ler os termos atuais de cada provedor (Anthropic, OpenAI, Google) antes de anunciar isso como recurso do produto.
- **Comportamento varia por CLI**: o mesmo agente pode responder diferente conforme o modelo de quem executa. A interface mostra qual CLI e modelo respondeu.
- **Custo cruzado**: quando o trabalho cai no runner do responsável, é a assinatura dele que paga pelo pedido de outra pessoa. A interface precisa mostrar isso.
- **Sandbox do sistema isola menos que container**: o agente usa as ferramentas instaladas na máquina, não um ambiente limpo. Quem dá mais autonomia aos agentes deve usar o modo container.
- **Privacidade**: os dados ficam na Cloudflare (conta do time) e as conversas com agentes vão para o provedor do modelo. Documentar.
- **Notificações no iPhone**: Web Push só funciona com o PWA adicionado à tela inicial.
- **Isolamento**: toda consulta ao D1 filtra por workspace, mesmo com um hub por time, para não depender dessa suposição depois.

## 7. Ordem de construção

1. Hub: login, workspace, canais e DMs em tempo real, interface web.
2. Runner: conexão ao hub e um agente respondendo em DM e por `@`, via Claude Code local, já atrás da interface de adaptador.
3. Fila de trabalho com entrega única, prazo e regras de quem executa.
4. Ferramentas nativas via MCP: mensagens, tarefas, wiki, drive.
5. Governança: responsável, quem pode falar, permissões por ferramenta, aprovações.
6. Isolamento no runner: sandbox do sistema como padrão, container como opção.
7. Adaptadores para Codex e Gemini CLI.
8. Memória individual e do time; rotinas agendadas; assistente pessoal com resumo diário.
9. PWA com Web Push; plugin de avisos no Telegram.
10. Roteador de mensagens; conectores externos; servidor MCP próprio.
