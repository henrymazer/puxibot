# Arquitetura

Visão técnica para quem vai contribuir. As decisões de produto e o mapeamento para a Cloudflare estão em [decisoes-de-arquitetura.md](decisoes-de-arquitetura.md); as rotas, eventos e regras de negócio, em [contrato-api.md](contrato-api.md).

## Estrutura do monorepo

Monorepo com npm workspaces, TypeScript em tudo, Node 22.

```
apps/
  hub/       Cloudflare Worker (Hono). API, Durable Object WorkspaceHub, migrações do D1
    src/routes/   uma rota Hono por domínio (canais, agentes, tarefas, ferramentas...)
    src/domain/   regras de negócio usadas pelas rotas e pelo DO
    src/do/       WorkspaceHub: WebSockets, fila de jobs, alarmes de rotinas
    src/http/     autenticação, segurança, tipos do contexto Hono
    src/lib/      banco, criptografia, token de job, cron, validação
    migrations/   SQL do D1, numerado (0001_init.sql, ...)
    test/         testes com @cloudflare/vitest-plugin (rodam no workerd)
  runner/    CLI `puxibot` (Node). Conexão com o hub, jobs, isolamento, adaptadores, servidor MCP
    src/adapters/ um adaptador por CLI de IA (claude, codex, gemini)
    src/mcp/      servidor MCP das ferramentas nativas e cliente da API /api/tool
    docker/       Dockerfile do modo container
  web/       Interface (React 19, Vite, Tailwind, Zustand), PWA servida pelo hub
    src/features/ uma pasta por área (chat, tarefas, wiki, equipe, configurações...)
    src/api/      cliente HTTP da API do hub
    src/realtime/ WebSocket do navegador e redutor de eventos
    public/       service worker (sw.js), manifesto, tela offline e _headers (CSP dos arquivos estáticos)
packages/
  shared/    Tipos, esquemas zod e constantes compartilhados (DTOs, protocolo do runner)
scripts/     dev.mjs (npm run dev), deploy-hub.mjs (npm run deploy)
docs/        documentação
```

Comandos da raiz:

| Comando | O que faz |
|---|---|
| `npm run dev` | Migrações locais e hub + interface com recarga automática |
| `npm run check` | Typecheck, testes, build e checagem do pacote do Worker (`wrangler deploy --dry-run`) |
| `npm run typecheck`, `npm run test`, `npm run build` | Cada etapa separada, em todos os workspaces |
| `npm run db:migrate` | Aplica as migrações no D1 local |
| `npm run deploy` | Publica o hub, sempre com confirmação (veja [deploy-cloudflare.md](deploy-cloudflare.md)) |
| `npm run pack -w @puxibot/runner` | Compila o runner e gera `apps/runner/puxibot-runner-<versão>.tgz`, instalável com `npm install -g` |

## Onde ficam os contratos

- `docs/contrato-api.md`: fonte da verdade das rotas, eventos de tempo real, protocolo do runner e API de ferramentas. Mudou o comportamento, mude o documento no mesmo commit.
- `packages/shared/src/index.ts`: os tipos e esquemas zod correspondentes (DTOs, `ClientEvent`, `ClientCommand`, `RunnerToHub`, `HubToRunner`, `JobAssignment`). Hub, interface e runner importam daqui.
- `apps/hub/migrations/`: o esquema do banco. Migração nova é sempre um arquivo novo; nunca edite uma já publicada.

## Fluxo de uma mensagem até a resposta do agente

```
Navegador          Hub (Worker)            WorkspaceHub (DO)        Runner                CLI de IA
    |  POST .../messages  |                        |                    |                       |
    |-------------------->| grava no D1, roteia    |                    |                       |
    |                     |----------------------->| cria job, escolhe  |                       |
    |                     |                        | runner, job.assign |                       |
    |                     |                        |------------------->| prepara pasta, monta  |
    |                     |                        |  (WebSocket)       | prompt, isola, inicia |
    |                     |                        |                    |---------------------->|
    |                     |                        |                    |   puxibot mcp (stdio) |
    |                     |   /api/tool/* (token de job)                |<----------------------|
    |                     |<--------------------------------------------|  ferramentas MCP      |
    |                     |                        |  job.stream/done   |                       |
    |                     |                        |<-------------------|                       |
    |<---------------- ClientEvent (WebSocket) ----|                    |                       |
```

1. **Mensagem**: a interface chama `POST /api/workspaces/:ws/channels/:id/messages`. A rota grava a mensagem e decide se algum agente deve responder (DM com agente, `@menção`, thread de agente ou roteador com Workers AI), depois de checar pausa, "quem pode falar" e orçamento (`src/domain/routing.ts`).
2. **Job**: o `WorkspaceHub` (um Durable Object por workspace) cria o job e escolhe o runner: o pai, em consulta entre agentes; o de quem pediu; o do responsável pelo agente; ou nenhum, e o job espera na fila. A entrega é única e tem prazo (lease); se o runner cair, o job volta para a fila.
3. **Runner**: recebe `job.assign` pelo WebSocket `/api/workspaces/:ws/runner`, confirma com `job.accepted`, prepara a pasta de trabalho do agente, escreve as instruções e o contexto (`src/prompt.ts`) e escolhe o adaptador da CLI (`src/adapters`).
4. **Isolamento**: `src/isolation.ts` envolve o comando da CLI com bubblewrap, Seatbelt ou container.
5. **Ferramentas**: a CLI inicia o `puxibot mcp` (servidor MCP por stdio). Cada ferramenta (`src/mcp/tools.ts`) chama `/api/tool/*` no hub com o token de job (`tbj_...`, assinado com `JOB_TOKEN_SECRET`), que vale só enquanto o job roda. O hub confere as permissões do agente em cada chamada (`src/routes/tool.ts`).
6. **Resposta**: o runner repassa o texto em streaming (`job.stream`) e, no fim, `job.done` com tokens e texto. O DO grava, cria a mensagem do agente na conversa e distribui os eventos aos navegadores (`ClientEvent`).

Dados: o D1 guarda tudo o que é relacional, inclusive mensagens e jobs; o R2 guarda os arquivos. O Durable Object coordena (conexões WebSocket hibernáveis, entrega dos jobs, prazos, alarme das rotinas) e guarda no próprio armazenamento só o id do workspace e o alarme.

## Como adicionar uma rota no hub

1. Defina tipos e esquema de corpo em `packages/shared/src/index.ts`.
2. Crie (ou edite) `apps/hub/src/routes/<dominio>.ts`, exportando um `new Hono<...>()` com caminhos relativos. Coloque a regra de negócio em `src/domain/`.
3. Registre o roteador na lista certa em `apps/hub/src/app.ts`:
   - `publicRouters`: montados em `/api`, cada rota cuida da própria autenticação;
   - `workspaceRouters`: montados em `/api/workspaces/:ws`, já exigem que quem chama seja membro;
   - `toolRouters`: montados em `/api/tool`, já exigem token de job.
4. Toda consulta filtra por `workspace_id`. Mudanças que a interface precisa ver na hora notificam o `WorkspaceHub`, que distribui o evento.
5. Se precisar de tabela ou coluna nova, crie `apps/hub/migrations/000N_<nome>.sql`.
6. Escreva o teste em `apps/hub/test/` e atualize `docs/contrato-api.md`.

## Como adicionar uma ferramenta de agente

Uma ferramenta tem duas metades:

1. **Hub**: a rota em `apps/hub/src/routes/tool.ts`, chamando `requirePerm(...)` com a ferramenta nativa (`messages`, `memory`, `tasks`, `wiki`, `drive`, `agents`) e o nível (`read` ou `write`). O agente do token de job é o ator; registre `onBehalfOfUserId` com quem pediu o job.
2. **Runner**: uma entrada no array `TOOLS` de `apps/runner/src/mcp/tools.ts` com `name`, `description`, `perm`, o esquema zod de `input` e o `run`, que chama a rota pelo `ctx.call(...)`.
3. Documente a ferramenta na tabela "API de ferramentas" de `docs/contrato-api.md` e teste as duas metades (`apps/hub/test/tool.test.ts` e os testes do runner).

## Como adicionar um adaptador de CLI

1. Acrescente o nome em `CLIS` de `packages/shared/src/index.ts`.
2. Crie `apps/runner/src/adapters/<cli>.ts` implementando `CliAdapter` (`src/adapters/types.ts`):
   - `detect`: acha o executável, a versão e se há login;
   - `prepare`: monta a linha de comando não interativa, entrega as instruções no formato da CLI, registra o servidor MCP `puxibot`, aponta o estado da CLI para `paths.cliState(cli, workspace, agente)` (`~/.puxibot/cli-state/<cli>/<ws>/<agente>`, um por agente) e declara as credenciais e pastas que o isolamento deve liberar;
   - `createParser`: lê a saída em streaming e devolve eventos (`text`, `tool`, `session`, `model`) e o resultado final com tokens;
   - `npmPackage`: pacote instalado na imagem do modo container;
   - `authEnv`: variáveis de login por chave de API que passam para a CLI isolada (o resto do ambiente do terminal não passa);
   - toda escrita na pasta de trabalho ou no estado da CLI passa por `src/safefs.ts` (não segue links simbólicos deixados pelo agente); o link do login usa `adapters/credentials.ts`;
   - `verified: false` até rodar com a CLI real.
3. Registre-o em `ADAPTERS` e `CLI_ORDER` de `apps/runner/src/adapters/index.ts` e as dicas de instalação e login em `src/doctor.ts`.
4. Escreva testes do parser com saídas reais gravadas. O teste com a CLI de verdade fica em `apps/runner/test/live.test.ts`, que só roda com `PUXIBOT_LIVE=1`.

## Testes

- Hub: `@cloudflare/vitest-plugin`, com D1, R2 e Durable Objects simulados e as migrações aplicadas antes (`apps/hub/test/apply-migrations.ts`).
- Interface: vitest em ambiente Node (`apps/web/src/**/*.test.ts`). O teste `src/pwa/csp.test.ts` e o build conferem que nenhuma página tem script inline fora da CSP de `public/_headers`.
- Runner: vitest; os testes com bubblewrap rodam só se ele existir, e os com CLI real só com `PUXIBOT_LIVE=1`.

A CI (`.github/workflows/ci.yml`) roda typecheck, testes, build e `wrangler deploy --dry-run`, sem testes `PUXIBOT_LIVE`.
