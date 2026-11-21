# Contrato da API do hub

Fonte da verdade para hub, web e runner. Tipos em `packages/shared/src/index.ts`; tabelas em `apps/hub/migrations/0001_init.sql`.
Se algo aqui precisar mudar durante a implementação, altere este arquivo e os tipos compartilhados no mesmo commit.

## Convenções

- Base: `/api`. Os arquivos da interface (static assets) não passam pelo Worker; os cabeçalhos de segurança deles (CSP etc.) ficam em `apps/web/public/_headers`. JSON em requisição e resposta. Erros: status HTTP adequado e corpo `ApiError` (`{ "error": { "code", "message" } }`), com `message` em português.
- Autenticação, três formas:
  - **Sessão** (navegador): cookie `tb_session` (HttpOnly, SameSite=Lax, Secure fora de localhost). Requisições com o cookie que mudam estado (POST/PUT/PATCH/DELETE, inclusive multipart) e o upgrade de WebSocket `/realtime` só passam se `Origin` for a do próprio hub (ou de `PUBLIC_URL`; em localhost, qualquer localhost) — sem `Origin`, recusa se `Sec-Fetch-Site` for `cross-site`/`same-site`. Recusa → 403 `csrf_origin`. Com `Authorization: Bearer tb_...` a checagem não se aplica.
  - **Token pessoal ou de runner**: `Authorization: Bearer tb_...` (tabela `api_tokens`). Vale para um workspace. Token de `kind = 'runner'` só vale no WebSocket `/runner` e em `GET /api/me`; nas demais rotas responde 403 `runner_token_not_allowed`.
  - **Token de job**: `Authorization: Bearer tbj_...`, emitido pelo hub em cada `JobAssignment`. Só vale em `/api/tool/*`, enquanto o job está `assigned` ou `running`. Assinado com HMAC (`JOB_TOKEN_SECRET`), contendo jobId, agentId, workspaceId e expiração.
- `:ws` é o id do workspace. Toda rota sob `/api/workspaces/:ws` exige que o chamador seja membro (quem não é recebe 404, sem revelar se o workspace existe); toda consulta filtra por `workspace_id`.
- Papéis: `owner` > `admin` > `member`. "Admin" abaixo significa owner ou admin.
- Listas retornam `{ items: [...] }`. Criação retorna o DTO criado com status 201.
- Paginação de mensagens: `?before=<createdAt>&limit=<n>` (padrão 50, máx. 100), mais novas por último.
  Cursor composto (segunda leva): `before` aceita também `<createdAt>:<id>`, estável quando várias mensagens têm o mesmo `createdAt`; a resposta traz `nextBefore` (cursor da página anterior, ou `null`). Ver `MessagesPageDTO`.
- Filtros `status` de `/jobs`, `/approvals` e `/tasks` aceitam lista separada por vírgula (`?status=queued,running`).
- Limites (revisão de segurança): corpo JSON até 2 MiB (413 `body_too_large`); tentativas em excesso → 429 `rate_limited` com `Retry-After` (tabela `rate_limits`, migração `0004`). Respostas de `/api/*` levam `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (`SAMEORIGIN` no conteúdo de arquivo aberto com `?inline=1`), `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, CSP `default-src 'none'; frame-ancestors 'none'` (o download de arquivo mantém o CSP `sandbox` dele) e `Cache-Control: no-store` quando a rota não define outro.

## Auth e conta

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | `/api/auth/signup-status` | — | `{ open, firstAccount }`. `open`: dá para criar conta sem convite (primeira conta da instalação, ou `OPEN_SIGNUP` ligado). |
| POST | `/api/auth/signup` | `signupSchema` | `{ user }` + cookie. Com `inviteCode`, entra no workspace do convite. Sem convite, só a primeira conta (ou com `OPEN_SIGNUP=true`); senão 403 `signup_closed`. |
| POST | `/api/auth/login` | `loginSchema` | `{ user }` + cookie |
| POST | `/api/auth/logout` | | 204 |
| GET | `/api/me` | | `{ user, workspaces: WorkspaceDTO[] }` |
| PATCH | `/api/me` | `{ name?, avatarColor? }` | `{ user }` |
| GET | `/api/invites/:code` | (sem auth) | `{ workspaceName, valid }`; código inexistente → 404 |
| POST | `/api/invites/:code/accept` | (sessão) | `{ workspace }`. Já membro: devolve o workspace sem gastar uso. Expirado/esgotado → 410 `invite_invalid` (também no signup com `inviteCode`). |

Senha: PBKDF2-SHA256 via WebCrypto, 100.000 iterações, salt de 16 bytes. Sessão dura 30 dias.
Login: no máximo 10 tentativas por e-mail e 30 por IP (`CF-Connecting-IP`) a cada 15 min → 429 `rate_limited` (login certo zera o contador do e-mail); e-mail inexistente custa o mesmo PBKDF2. Cadastro: 10 por IP por hora. O cadastro ainda responde 409 `email_taken` (sem verificação de e-mail não há como esconder; o limite por IP reduz a enumeração).

## Workspace

| Método | Rota | Notas |
|---|---|---|
| POST | `/api/workspaces` | `createWorkspaceSchema`. Cria o workspace, o canal `general`, e o assistente pessoal do criador (ver "Assistente"). No máximo 20 workspaces criados por pessoa (429 `workspace_limit`). |
| GET | `/api/workspaces/:ws` | `{ workspace }` |
| PATCH | `/api/workspaces/:ws` | Admin. `{ name?, business?, routerEnabled? }` → `{ workspace }` |
| GET | `/api/workspaces/:ws/bootstrap` | Tudo que a interface precisa ao abrir: `{ workspace, me: MemberDTO, members, sectors, agents, channels, runners, pendingApprovals, unreadNotifications }` (`BootstrapDTO`) |
| GET | `/api/workspaces/:ws/members` | |
| PATCH | `/api/workspaces/:ws/members/:userId` | Admin muda `role`/`title`/`sectorId` (setor da pessoa, `null` tira); a própria pessoa muda `statusText`. Não rebaixa o último owner. Só owner dá/tira `owner`. → `{ member }` |
| DELETE | `/api/workspaces/:ws/members/:userId` | Admin, ou a própria pessoa saindo. |
| POST | `/api/workspaces/:ws/invites` | Admin. `{ role?, maxUses?, expiresInDays? }` → `{ code, url }` |
| GET/POST/PATCH/DELETE | `/api/workspaces/:ws/sectors[/:id]` | Admin para escrever. `{ name, leadUserId? }`. GET lista → `{ items: SectorDTO[] }`; GET/PATCH → `SectorDTO`; POST → `SectorDTO` (201); DELETE → 204. |
| GET | `/api/workspaces/:ws/search?q=` | `{ messages, tasks, wikiPages, files }` (`SearchResultsDTO`; LIKE, máx. 20 por tipo; respeita canais que a pessoa enxerga; `wikiPages` sem `body`) |
| POST | `/api/workspaces/:ws/feedback` | `{ body }` → `{ id, createdAt, channelId, messageId }` (201). Grava e, se existir o canal `feedbacks` (ou `feedback`), publica nele como mensagem da pessoa (`**Feedback:** …`), passando pelo roteamento — só se a pessoa enxerga esse canal (privado sem ela: só grava; `channelId`/`messageId` = `null`). |
| POST | `/api/workspaces/:ws/starter-team` | Admin. `{ business }` (texto livre ou chave `agencia`/`loja`/`software`/`servicos`/`generico`) → `StarterTeamResponse`. Cria 3–5 agentes do ramo, canais sugeridos e coloca os agentes nos canais. Idempotente (não duplica handles nem canais): 201 se criou algo, 200 se não. |

## Tokens e runners

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/tokens` | Tokens da própria pessoa (sem o segredo): `ApiTokenDTO[]`. |
| POST | `/api/workspaces/:ws/tokens` | (sessão) `{ name, kind: 'personal'|'runner' }` → `{ token, apiToken: ApiTokenDTO }` (201; `token` mostrado uma única vez). Com token pessoal → 403 `session_required` (token vazado não fabrica outros). |
| DELETE | `/api/workspaces/:ws/tokens/:id` | |
| GET | `/api/workspaces/:ws/runners` | `RunnerDTO[]` |
| DELETE | `/api/workspaces/:ws/runners/:id` | Dono do runner ou admin. Também aceita o **token de runner** (`puxibot logout`), só para o runner que conectou com esse mesmo token (`runners.token_id`, migração 0003); outro id → 403. |
| POST | `/api/runner/pair/start` | (sem auth) `{ name }` → `{ pairCode, pollToken, approveUrl, expiresAt }` (201). Fluxo de pareamento do runner sem copiar token à mão. `pairCode` tem o formato `XXXX-XXXX`. `approveUrl` = `<PUBLIC_URL ou origem>/parear?code=<pairCode>`. Até 20 por IP a cada 10 min (429). |
| POST | `/api/workspaces/:ws/runner/pair/approve` | (sessão) `{ pairCode }` → `{ ok: true, name }`. A pessoa aprova na interface; cria um token de runner dela nesse workspace. Código inválido/expirado → 404. Até 10 tentativas por pessoa a cada 10 min (429): adivinhar o código de outra pessoa ligaria o runner dela a quem aprovou. |
| POST | `/api/runner/pair/poll` | `{ pollToken }` → `{ status: 'pending' }` ou `{ status: 'approved', token, workspaceId, hubUrl }` (entregue uma única vez). Expirado, inexistente ou já entregue → 410 `pairing_expired`. |

Pareamentos pendentes ficam na tabela `runner_pairings` (migração `0002`); expiram em 10 minutos. Nenhuma rota devolve o nome da máquina antes da aprovação; a interface só o mostra depois, a partir da resposta do `approve`.
Tipos: `RunnerPairStartResponse` e `RunnerPairPollResponse`. O `start` pode trazer `approveUrl` (opcional) com o endereço da tela de aprovação; sem ele, o runner mostra `<hub>/runner/parear?codigo=<pairCode>` e manda a pessoa a Configurações › Computadores.

## Tempo real

- `GET /api/workspaces/:ws/realtime` (upgrade WebSocket, sessão): recebe `ClientEvent`, envia `ClientCommand`.
- `GET /api/workspaces/:ws/runner` (upgrade WebSocket, token de runner): protocolo `RunnerToHub` / `HubToRunner`.

Ambos terminam no Durable Object `WorkspaceHub` (um por workspace, WebSockets hibernáveis). Rotas HTTP que mudam dados notificam o DO, que distribui o evento a quem pode vê-lo (eventos de canal só para membros do canal; canais não privados contam como visíveis a todos os membros do workspace).

## Canais e mensagens

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/channels` | Canais que a pessoa enxerga, com `unread`. |
| POST | `/api/workspaces/:ws/channels` | `{ name, section?, topic?, humansOnly?, isPrivate?, members?: ActorRef[] }` |
| PATCH/DELETE | `/api/workspaces/:ws/channels/:id` | Criador ou admin. PATCH → `ChannelDTO`; DELETE → 204. |
| POST/DELETE | `/api/workspaces/:ws/channels/:id/members` | `{ member: ActorRef }` → `ChannelDTO`. Agente não entra em canal `humansOnly`. Canal aberto: qualquer membro do workspace entra sozinho (`member` = ele mesmo); adicionar outra pessoa ou agente, ou remover outro: criador do canal ou admin. DELETE também aceita `?type=user|agent&id=` (sem corpo). |
| POST | `/api/workspaces/:ws/dms` | `{ with: ActorRef }` → `ChannelDTO` da DM (201 se criada, 200 se já existia). DM com agente respeita "quem pode falar" (403 `agent_access_denied`). |
| GET | `/api/workspaces/:ws/channels/:id/messages` | `?before&limit&threadRootId&pinned` → `MessagesPageDTO` `{ items, nextBefore, root? }`. `pinned=1` lista só as fixadas (canal inteiro, mais novas por último). Com `threadRootId`: as respostas, mais `root` (a mensagem raiz), que também vem como `items[0]` na página mais antiga da thread. |
| GET | `/api/workspaces/:ws/messages/:id` | Uma mensagem avulsa → `MessageDTO` (404 se o canal não é visível). |
| POST | `/api/workspaces/:ws/channels/:id/messages` | `sendMessageSchema` → `MessageDTO` (201). Dispara o roteamento (abaixo). `attachmentIds`: arquivos visíveis a quem envia e deste canal (ou sem canal: drive, ou upload pendente da própria pessoa, que passa a ser deste canal) — senão 404. `quote.messageId` precisa ser deste canal (404). `@pessoa` só notifica quem enxerga o canal. |
| PATCH | `/api/workspaces/:ws/messages/:id` | Autor: `{ body }`. Qualquer membro do canal: `{ pinned }`. → `MessageDTO` |
| DELETE | `/api/workspaces/:ws/messages/:id` | Autor ou admin (soft delete). → 204 |
| POST/DELETE | `/api/workspaces/:ws/messages/:id/reactions` | `{ emoji }` → `MessageDTO` atualizado. DELETE também aceita `?emoji=` (sem corpo). |
| POST | `/api/workspaces/:ws/channels/:id/read` | Marca como lido. |

### Roteamento de mensagens para agentes

Ao criar uma mensagem de pessoa:

1. **DM com agente**: cria job para esse agente.
2. **Canal, com `@handle` de agente**: cria job para cada agente mencionado que seja membro do canal ou cujo `accessMode` permita.
3. **Canal, sem menção, com agentes membros e `routerEnabled`**: o roteador escolhe no máximo um agente, ou nenhum. Usa o binding `AI` (Workers AI, modelo `@cf/meta/llama-3-8b-instruct` em JSON mode, saída `{ "agent": "<handle>" | null }` validada contra os agentes ativos do canal); sem o binding, ou com qualquer falha, não roteia.
4. **Thread** iniciada por resposta de agente: resposta de pessoa na thread vai para o mesmo agente sem precisar de menção.
5. Canal `humansOnly`: nunca cria job.

Menção de pessoa: pessoas não têm handle no banco; o handle de menção é `userHandle(user)` de `@puxibot/shared` (parte local do e-mail normalizada). O hub resolve `@handle` primeiro contra agentes e depois contra esse handle das pessoas para preencher `mentions`.

Antes de criar o job, checar nesta ordem e, em caso de bloqueio, publicar mensagem `system` curta na conversa explicando:

- agente `paused`;
- "quem pode falar" (`accessMode`); assistente pessoal só responde ao dono;
- orçamento do mês esgotado (`budgetRunsMonth` / `budgetTokensMonth`, somando `jobs` do período).

Ao passar de 80% do orçamento, notificar o responsável uma vez por período (`budget_warned_period`).

## Agentes

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/agents` | `{ items: AgentDTO[] }` |
| POST | `/api/workspaces/:ws/agents` | `createAgentSchema` (aceita `avatarColor`/`avatarAccessory` opcionais). Qualquer membro cria; vira responsável. Permissões nativas padrão: todas `write`. |
| GET | `/api/workspaces/:ws/agents/:id` | `AgentDTO` (sem envelope) |
| PATCH | `/api/workspaces/:ws/agents/:id` | Responsável ou admin: perfil, instruções, acesso, permissões de ferramentas, skills, CLI preferida, política de autoinício. **Só admin**: `ownerUserId`, `budget*`. **Assistente pessoal**: só a pessoa dona configura; admin só muda `status` e `budget*` (outro campo → 403 `assistant_owner_only`). Conector: só o dono do conector concede `connector:<id>`. → `AgentDTO` (sem envelope). `toolPerms` faz **merge** (só as chaves enviadas mudam); `skillIds`, `allowedUserIds` e `callableAgentIds` substituem a lista inteira. |
| DELETE | `/api/workspaces/:ws/agents/:id` | Responsável ou admin. Assistente pessoal não é apagado. → 204 |
| GET | `/api/workspaces/:ws/agents/:id/usage?period=` | `AgentUsageDTO`. Visível só a admins e ao responsável (os demais: 403). |
| GET | `/api/workspaces/:ws/agents/:id/activity` | Últimos jobs com eventos: `{ items: (JobDTO & { events: JobEventDTO[] })[] }` |
| GET/POST/PATCH/DELETE | `/api/workspaces/:ws/agents/:id/memories[/:mid]` | Memória individual. GET `?q=` → `{ items: MemoryDTO[] }`; POST (201)/PATCH `{ content }` → `MemoryDTO`; DELETE → 204. Qualquer membro lê (exceto a do assistente de outra pessoa); responsável ou admin escreve. |
| GET/POST/PATCH/DELETE | `/api/workspaces/:ws/memories[/:mid]` | Memória do time. Mesmos formatos. **Qualquer membro** lê e edita. |
| GET/POST/PATCH/DELETE | `/api/workspaces/:ws/skills[/:id]` | `{ name, description?, body }` → `SkillDTO` (com `createdBy`). Qualquer membro cria; quem criou ou admin edita/apaga. Vínculo com agente: `PATCH /agents/:id { skillIds }`. |
| GET/POST/PATCH/DELETE | `/api/workspaces/:ws/connectors[/:id]` | `{ name, transport: 'http'|'stdio', url?, command?, args?, headers?, env? }` → `ConnectorDTO`. Segredos (`headers`, `env`) entram no POST/PATCH, são gravados cifrados (AES-GCM, `SECRETS_KEY`) e nunca voltam em GET (só `hasSecrets` e os nomes em `secretHeaderNames`/`secretEnvNames`). PATCH só pelo dono; enviar `headers` (ou `env`) substitui aquele grupo e mantém o outro. DELETE: dono ou admin (remove também as permissões `connector:<id>` dos agentes). Decifrados só no `JobAssignment.connectors` **e só quando o runner que recebe o job é da pessoa dona do conector** (em outro runner o conector não vai, nem a config: um `command` stdio rodaria na máquina de outra pessoa). |
| GET/POST/PATCH/DELETE | `/api/workspaces/:ws/routines[/:id]` | Responsável do agente ou admin (rotina de **assistente pessoal**: só a dona cria, muda e executa; admin só apaga). `channelId` precisa ser visível a quem cria e ao agente (nunca `humansOnly`; privado/DM só com o agente membro) → senão 400 `invalid_channel`. POST `createRoutineSchema` `{ agentId, name, prompt?, cron, timezone?, channelId?, enabled? }` → `RoutineDTO` (201); PATCH `{ name?, prompt?, cron?, timezone?, channelId?, enabled? }` → `RoutineDTO`; GET lista `?agentId=` → `{ items }` (rotinas do assistente de outra pessoa só aparecem para admins). `nextRunAt` calculado pelo hub (cron de 5 campos no fuso da rotina; `null` quando desligada). Cron/fuso inválido → 400 `invalid_cron`. |
| POST | `/api/workspaces/:ws/routines/:id/run` | Executa agora → `{ kind, job: JobDTO | null, messageId: string | null, skipped: string | null }`. `custom`: job `origin = 'user'` pedido por quem clicou (sem aprovação de autoinício), com `routineId`. `daily_summary`: publica o resumo (sem job). Não muda o próximo horário. |

### Assistente pessoal

Cada membro tem um agente com `isAssistant = 1`, criado quando entra no workspace: handle `assistente-<primeiro nome>` (com sufixo se colidir), `accessMode = 'owner'`, e uma rotina `daily_summary` às 9h (`0 9 * * *`, `America/Sao_Paulo`) em DM com o dono. Pelas ferramentas, age com as permissões do dono (pode criar agentes e mandar mensagens em nome dele, identificadas como vindas do assistente).

**Resumo diário** (`daily_summary`): montado pelo próprio hub, sem job e sem IA (funciona sem runner). Publica na DM do dono uma mensagem do assistente com um cartão `stats` ("Tarefas concluídas", "Jobs que falharam", "Esperando você") e um `checklist` "Precisa de você" (aprovações pendentes → `/w/<ws>/aprovacoes`; jobs que pararam com erro e jobs esperando um computador → link da conversa ou do agente), sobre as últimas 24 h, e notifica o dono (`dm`).

**Rotinas e alarme**: o `WorkspaceHub` agenda o alarme no menor entre o vencimento de lease e o `next_run_at` das rotinas ligadas; ao disparar, cada rotina vencida é reivindicada com UPDATE condicional (avança `next_run_at` antes de executar, não roda duas vezes). `custom` cria job `origin = 'routine'` (com `selfStartPolicy = 'ask'` nasce `awaiting_approval`); agente pausado ou sem orçamento: pula a execução. Linhas sem `next_run_at` são corrigidas (backfill) quando o DO acorda e por um cron do Worker a cada 30 min, que também acorda os DOs com rotina vencendo na próxima hora. Horário de verão: horário local inexistente roda logo depois do pulo; horário repetido roda uma vez.

## Jobs e aprovações

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/jobs?status=&agentId=&channelId=` | `{ items: JobDTO[] }`. `status` aceita lista (`queued,running`). `channelId` filtra jobs da conversa (a interface usa para mostrar jobs em andamento ao abrir um canal). `JobDTO.waitingForRunner`: job `queued` sem nenhum runner elegível online (mantido pelo hub a cada reavaliação da fila; coluna `jobs.waiting_for_runner`). `JobDTO.taskId`: tarefa que originou o job. O responsável pelo agente e os admins veem também jobs de conversas que não enxergam, mas com `prompt` vazio (e sem eventos em `/agents/:id/activity`): o pedido feito na DM ou canal privado de outra pessoa não vaza. Vale também na resposta de `cancel`/`retry`. |
| POST | `/api/workspaces/:ws/jobs/:id/cancel` | Quem pediu, responsável ou admin. → `JobDTO` |
| POST | `/api/workspaces/:ws/jobs/:id/retry` | Reenfileira job `failed`. → `JobDTO` |
| GET | `/api/workspaces/:ws/approvals?status=` | `{ items: ApprovalDTO[] }`, as que a pessoa pode decidir (responsável) — admin vê todas. `status` aceita lista. |
| POST | `/api/workspaces/:ws/approvals/:id/decide` | `{ decision: 'approved'|'rejected', note? }` → `ApprovalDTO`. Só o `approverUserId` ou admin. |

### Ciclo de vida do job (no `WorkspaceHub`)

- **Criação**: se `origin` é `routine` ou `agent` sem pedido humano na cadeia, e o agente tem `selfStartPolicy = 'ask'`, o job nasce `awaiting_approval` com uma aprovação `job_start` para o responsável. Caso contrário nasce `queued`.
- **Escolha do runner** (job `queued`), respeitando `capacity` do runner e `maxConcurrentJobs` do agente. **Só é candidato o runner cuja pessoa dona ainda é membro, pode falar com o agente (`accessMode`) e enxerga o canal do job** (o `JobAssignment` leva o contexto da conversa). Ex.: DM de Mara com um agente de Olga só roda no runner de Mara; se ela não tem runner, o job espera (`waitingForRunner`). Na ordem abaixo:
  1. `origin = 'agent'`: o runner que executa o job pai — **mesmo acima da `capacity`**, até `CHILD_JOB_EXTRA_CAPACITY` (3) jobs a mais, enquanto o pai está `assigned`/`running` (o pai está parado esperando o filho; sem isso um runner com capacidade 1 nunca executaria a consulta). O `JobAssignment` leva `parentJobId` (opcional, aditivo), e o runner aceita o filho acima da capacidade quando o pai roda nele;
  2. runner online de `requestedByUserId`;
  3. runner online do responsável pelo agente;
  4. nenhum: fica `queued`; notificar quem pediu (`no_runner`) uma vez. Reavaliar a fila quando um runner conectar ou um job terminar.
  - Se `preferredCli` do agente não existir no runner candidato, tentar o próximo candidato.
- **Entrega**: `job.assign` → `assigned` com `lease_expires_at = agora + JOB_LEASE_MS`. `job.accepted` → `running`. `job.heartbeat` renova a posse.
- **Expiração** (alarme do DO) ou runner desconectado: volta para `queued` com `attempts + 1`; após `JOB_MAX_ATTEMPTS`, `failed` com `runner_lost`.
- **`job.stream`**: repassado como `ClientEvent` `job.stream`, sem gravar.
- **`job.done`**: grava tokens e `result_text` (texto cortado em 100 mil caracteres; `cli` fora de `CLIS` vira `null`, `model` até 100 caracteres; `hello` só guarda CLIs conhecidas e `isolation` válida; até 20 WebSockets de navegador e 5 de runner por pessoa — a conexão mais antiga é fechada com 4008); se o job tem canal e o texto não é vazio, cria a mensagem do agente (com `meta` de cli/modelo/runner) na conversa ou thread de origem.
- **`job.failed`**: grava erro; publica mensagem `system` na conversa ("Marcos parou com um erro: …") e notifica o responsável.
- **`job.rejected` de job já aceito**: quando o runner está encerrando (Ctrl+C/SIGTERM), ele mata o processo e manda `job.rejected` com `reason` começando por `runner_shutdown`; o hub devolve o job para a fila como na expiração, sem esperar o lease.
- **`job.cancel`**: o runner mata o processo (e os filhos) e não manda mais nenhuma mensagem sobre o job.
- **Reentrega**: se o hub reenviar `job.assign` de um job que o runner ainda executa (por exemplo, após uma reconexão), o runner responde `job.accepted` de novo e continua; ao reconectar, ele manda `job.heartbeat` de todos os jobs em andamento logo depois do `welcome`, e as mensagens `job.accepted/rejected/event/done/failed` produzidas durante a queda.
- **Token revogado**: o hub pode fechar o WebSocket do runner com código 4001 (ou recusar o upgrade com 401/403); o runner para de reconectar e pede um novo `puxibot login`.

## Tarefas

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/tasks?status=&assignee=&project=&label=&q=` | `{ items: TaskDTO[] }`. `status` aceita lista; `assignee` = `user:<id>`, `agent:<id>`, `me` ou `none`; `q` busca no título/descrição (ou `#número`). |
| POST | `/api/workspaces/:ws/tasks` | `createTaskSchema` (+ `subtasks?`, `links?`, `position?`) → `TaskDTO` (201). Número sequencial atômico por workspace. |
| GET/PATCH/DELETE | `/api/workspaces/:ws/tasks/:id` | GET/PATCH → `TaskDTO`. PATCH aceita qualquer campo de `TaskDTO` editável, inclusive `status`, `position`, `subtasks` (`id` opcional; o hub gera), `links`, `assignee` (`null` tira). Mudar de `status` sem `position` põe no fim da coluna. DELETE (quem criou ou admin) → 204. |
| GET/POST | `/api/workspaces/:ws/tasks/:id/comments` | GET → `{ items: TaskCommentDTO[] }` (mais antigos primeiro); POST `{ body }` → `TaskCommentDTO` (201). |
| POST | `/api/workspaces/:ws/tasks/resume-stalled` | "Continuar todas": cria job para o agente responsável de cada tarefa `doing` parada há mais de 1 dia (sem job ativo dele para a tarefa) → `{ stalled: number, items: JobDTO[] }`. |

Atribuir uma tarefa a um agente ou comentar mencionando-o (`@handle`) cria um job para ele com a tarefa no pedido (`JobDTO.taskId`; sem canal: a resposta final do agente vira comentário na tarefa). Pedido de pessoa respeita pausa, "quem pode falar" e orçamento (bloqueado = sem job). Feito por agente: job filho `origin = 'agent'` (sujeito ao autoinício), nunca para ele mesmo nem para assistente, só para agente com quem a pessoa por quem ele age pode falar, e nunca para agente que já está na cadeia de jobs pais nem além de 3 níveis (freio de laço A→B→A). Links de tarefa (`links[].url`) e de cartões (`checklist.items[].link`) só aceitam `http(s)://` (cartões também caminho relativo `/w/...`); cartões inválidos vindos do runner no `job.done` são descartados. Atribuir a uma pessoa ou mencioná-la em comentário gera notificação `mention`. Eventos: `task.upserted` (também quando muda a contagem de comentários) e `task.deleted`, para todo o workspace.

## Wiki

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/wiki` | Árvore (sem `body`) → `{ items: WikiPageDTO[] }`. `?trash=1` lista a lixeira. |
| POST | `/api/workspaces/:ws/wiki` | `{ title, body?, parentId?, isFolder?, note? }` → `WikiPageDTO` (201; versão 1 e revisão 1). |
| GET | `/api/workspaces/:ws/wiki/:id` | Página completa → `WikiPageDTO`. Registra leitura (`wiki_reads`). |
| PATCH | `/api/workspaces/:ws/wiki/:id` | `{ title?, body?, parentId?, note?, baseVersion? }` → `WikiPageDTO`. Cria revisão. `baseVersion` desatualizada → 409 `wiki_conflict` (UPDATE condicional, atômico). Mover para dentro de si mesma/descendente → 400. |
| DELETE | `/api/workspaces/:ws/wiki/:id` | Lixeira (leva junto os descendentes) → 204. `?permanent=1` apaga (admin). |
| POST | `/api/workspaces/:ws/wiki/:id/restore` | → `WikiPageDTO`. Restaura também os descendentes que foram juntos; pai ainda na lixeira → vai para a raiz. |
| GET | `/api/workspaces/:ws/wiki/:id/revisions` | `{ items: WikiRevisionDTO[] }`, mais nova primeiro. |
| GET | `/api/workspaces/:ws/wiki/:id/stats` | `WikiStatsDTO` |
| GET | `/api/workspaces/:ws/wiki-graph` | `WikiGraphDTO` `{ nodes: {id,title}[], edges: {from,to}[] }` a partir de links `[[Título]]` (ou `[[Título|texto]]`, sem diferenciar maiúsculas) entre páginas. |

Evento `wiki.changed { pageId }` (todo o workspace) em criar, editar, lixeira, restaurar e apagar. `WikiStatsDTO`: leituras nos últimos 7 dias, leitores dos últimos 30 dias, e onde a página é citada com `[[Título]]` (páginas e mensagens de canais que quem pergunta enxerga).

## Drive

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/files?folder=&q=` | Só `in_drive = 1` → `{ items: FileDTO[] }`. `folder=` vazio = só a raiz; `q` filtra pelo nome. Arquivos de canal só aparecem para quem enxerga o canal. |
| POST | `/api/workspaces/:ws/files` | `multipart/form-data` (`file`, `folder?`, `channelId?`, `inDrive?` — `0`/`false` = só anexo) → `FileDTO` (201). Máx. 25 MB (413 `file_too_large`). Grava em R2 `ws/<ws>/<id>/<nome>`. Evento `file.created` (só `in_drive = 1`). Anexo de mensagem: mesmo upload com `inDrive=0` e o `id` em `sendMessageSchema.attachmentIds`. Exige `Content-Length` (411 `length_required`). O tipo gravado é saneado (`tipo/subtipo`, senão `application/octet-stream`). |
| GET | `/api/workspaces/:ws/files/:id` | `FileDTO`. |
| GET | `/api/workspaces/:ws/files/:id/content` | Stream do R2 com `Content-Type`, `Content-Disposition` (`attachment`, nome em `filename*`), `X-Content-Type-Options: nosniff` e CSP `sandbox; default-src 'none'; frame-ancestors 'none'` + `X-Frame-Options: DENY`. `?inline=1` abre no navegador só imagens, PDF, texto, áudio e vídeo (`inline`, CSP com `frame-ancestors 'self'` e `X-Frame-Options: SAMEORIGIN`: a pré-visualização do drive mostra o PDF num `<iframe>` da interface); os demais tipos (HTML, SVG, XML...) saem sempre como `application/octet-stream` + `attachment`. |
| PATCH/DELETE | `/api/workspaces/:ws/files/:id` | Autor ou admin. PATCH `{ name?, folder?, inDrive? }` → `FileDTO`; DELETE → 204 (apaga também do R2). |

## Notificações

| Método | Rota | Notas |
|---|---|---|
| GET | `/api/workspaces/:ws/notifications` | |
| POST | `/api/workspaces/:ws/notifications/read` | `{ ids?: string[] }` (vazio = todas) |
| GET | `/api/me/notifications?unread=1&limit=` | (sessão ou token pessoal) Notificações da pessoa em todos os workspaces (com token pessoal, só as do workspace do token) → `{ items: MyNotificationDTO[] }` (com `workspaceId`). É o que o service worker busca ao receber um push. |
| GET | `/api/push/public-key` | `{ key }` VAPID, ou 404 se não configurado. |
| POST/DELETE | `/api/push/subscriptions` | Inscrição Web Push do navegador. POST: o `PushSubscription.toJSON()` (`pushSubscriptionSchema`: `{ endpoint, keys: { p256dh, auth } }`) → `{ ok: true }` (201; endpoint repetido é atualizado). O endpoint precisa ser `https://` na porta padrão e com nome público (localhost, IP privado/link-local, IPv6 literal e nomes internos → 400 `invalid_push_endpoint`). No máximo 10 inscrições por pessoa (as mais antigas saem). DELETE: `{ endpoint }` ou `?endpoint=` → 204. |
| GET/POST/DELETE | `/api/telegram/link` | GET devolve (criando se preciso) `TelegramLinkDTO` `{ botUsername, linkCode, linked }`; POST gera um código novo; DELETE desvincula (204). 404 se `TELEGRAM_BOT_TOKEN` não configurado. A pessoa manda `/start <linkCode>` ao bot (ou abre `https://t.me/<botUsername>?start=<linkCode>`). |
| POST | `/api/telegram/webhook/:secret` | Webhook do bot (`:secret` = `TELEGRAM_WEBHOOK_SECRET`; outro valor → 404). Trata `/start <link_code>` (vincula o chat) e `/stop` (pausa). Sempre 200 `{ ok: true }`. |

Toda notificação criada gera: evento `notification.created`, Web Push (se inscrito e VAPID configurado) e aviso no Telegram (se vinculado). O texto enviado ao Telegram nunca inclui conteúdo de mensagem: só "Marcos respondeu em #dev" e o link.

- **Web Push sem conteúdo**: o hub envia o push **sem payload** (VAPID, JWT ES256 com `aud` = origem do endpoint, `exp` 12 h, `sub` = `VAPID_SUBJECT`; `TTL: 86400`). O service worker, ao receber o evento `push`, chama `GET /api/me/notifications?unread=1` (cookie de sessão) para montar o aviso. Inscrições que respondem 404/410 são apagadas.
- **Telegram**: envia só o `title` da notificação e o link absoluto (`PUBLIC_URL` + `link`; sem `PUBLIC_URL`, só o título). Nunca o `body`. Por isso os títulos de notificação são genéricos (ex.: aprovação pedida por agente: "Marcos pediu sua aprovação"; o pedido vai no `body`).

## API de ferramentas (usada pelo servidor MCP do runner)

Base `/api/tool`, autenticada com token de job. O agente do token é o ator. Cada rota confere `agent_tool_perms` (`read` para consultar, `write` para alterar) e responde 403 com mensagem clara quando falta permissão.

| Ferramenta MCP | Método e rota | Permissão |
|---|---|---|
| `enviar_mensagem` | POST `/api/tool/messages` `{ channel?: nome-ou-id, toUser?: nome-ou-email, toAgent?: handle, body, cards?, threadRootId? }` | messages:write |
| `ler_mensagens` | GET `/api/tool/messages?channel=&limit=&before=` | messages:read |
| `listar_canais` | GET `/api/tool/channels` | messages:read |
| `buscar` | GET `/api/tool/search?q=` | messages:read |
| `lembrar` | POST `/api/tool/memories` `{ scope: 'agent'|'team', content }` | memory:write |
| `consultar_memoria` | GET `/api/tool/memories?q=&scope=` | memory:read |
| `esquecer` | DELETE `/api/tool/memories/:id` | memory:write |
| (runner, sem ferramenta) | POST `/api/tool/memories/review` (revisão automática ao fim do trabalho) | memory:write |
| `listar_tarefas` | GET `/api/tool/tasks?status=&assignee=&q=` | tasks:read |
| `criar_tarefa` | POST `/api/tool/tasks` | tasks:write |
| `atualizar_tarefa` | PATCH `/api/tool/tasks/:numero` | tasks:write |
| `comentar_tarefa` | POST `/api/tool/tasks/:numero/comments` | tasks:write |
| `listar_wiki` | GET `/api/tool/wiki` | wiki:read |
| `ler_pagina_wiki` | GET `/api/tool/wiki/:idOuTitulo` (registra leitura) | wiki:read |
| `escrever_pagina_wiki` | PUT `/api/tool/wiki` `{ id?, title, body, parentTitle?, note? }` | wiki:write |
| `listar_arquivos` | GET `/api/tool/files?q=` | drive:read |
| `baixar_arquivo` | GET `/api/tool/files/:id/content` | drive:read |
| `salvar_no_drive` | POST `/api/tool/files` (multipart) | drive:write |
| `listar_time` | GET `/api/tool/team` (pessoas e agentes, com função) | agents:read |
| `consultar_agente` | POST `/api/tool/agents/:handle/ask` `{ prompt }` → cria job filho e espera (long-poll, até o timeout) → `{ text }`. Respeita `agentsCanConsult` do alvo, `callableAgents*` do chamador e o "quem pode falar" do alvo para a pessoa por quem o chamador age (403 `consult_denied`). | agents:write |
| `pedir_aprovacao` | POST `/api/tool/approvals` `{ title, details }` → cria aprovação `action`; GET `/api/tool/approvals/:id` para aguardar a decisão. | sempre permitido |
| `criar_agente`, `criar_rotina` | POST `/api/tool/agents`, POST `/api/tool/routines` | só assistente pessoal (age como o dono) |
| `reportar_progresso` | POST `/api/tool/progress` `{ summary }` → `job_events` | sempre permitido |

Mensagens e alterações feitas por agente registram `on_behalf_of` / `requestedBy` do job quando houver, para a interface mostrar "Tito, a pedido de Renato".

Corpos que o servidor MCP do runner envia onde a tabela não detalha:

- `criar_tarefa`: `{ title, description?, status?, priority?, labels?, project?, assigneeAgent?: handle, assigneeUser?: nome-ou-email }`.
- `atualizar_tarefa`: os mesmos campos, todos opcionais, mais `subtasks?` e `links?` (formato de `TaskDTO`).
- `comentar_tarefa`: `{ body }`.
- `salvar_no_drive`: multipart com `file`, `inDrive = "true"`, `folder?` e `channelId?` (o canal do job).
- `pedir_aprovacao`: o runner lê o id em `id` (ou `approval.id`) e o estado em `status` (ou `approval.status`) do GET.
- `criar_agente`: `{ handle, name, role?, description?, instructions? }`. `criar_rotina`: `{ agent?: handle (padrão: o próprio), name, prompt, cron, timezone?, channel?: nome-ou-id }`.
- `POST /memories/review` `{ add: [{ scope, content }], remove: [id], usage?: { inputTokens, outputTokens } }` → `{ added, removed }`. Revisão automática de memória, mandada pelo runner depois do `job.done`. Limites: 3 em `add`, 3 em `remove`, 500 caracteres por texto (400 acima disso). `add` entra com `source: 'extraction'` e ignora texto já existente; `remove` só apaga memória do time ou do próprio agente cuja `source` não seja `'user'` (as outras são ignoradas em silêncio). `usage` soma aos tokens do job. Grava um evento `note` no job ("Memória revisada." + linhas `+`/`−`). Exige `memory: write`.
- Janela depois do fim: com o job em `done` há no máximo 3 minutos (`MEMORY_REVIEW_GRACE_MS`), o token de job ainda vale para `GET /memories` e `POST /memories/review`, e só para essas duas.
- `JobAssignment.memories[]` traz `id` e `removable` (`source !== 'user'`).
- `ler_mensagens` sem `channel` usa o canal do job.

Respostas e regras da API de ferramentas (segunda leva):

- Sem token de job, token inválido ou job que não está `assigned`/`running` → 401. Falta de permissão → 403 `tool_permission_denied` com mensagem do tipo "Marcos não tem permissão para alterar tarefas (está como "só leitura" em tasks). O responsável pelo agente ou um admin pode liberar em Ferramentas e acesso." `read` vale para consultar, `write` para consultar e alterar.
- **Visibilidade**: agente nunca enxerga canal `humansOnly` nem canal privado/DM de que não é membro (vale também para o assistente pessoal). **E age só com o que a pessoa por quem trabalha enxerga** (quem pediu o job; sem pedido humano, o responsável): canal privado/DM fora do alcance dela também fica invisível (exceto o próprio canal do job). Sem isso, Yara poderia pedir a um agente que lesse a DM de Xavier com ele. Se essa pessoa saiu do workspace → 403 `principal_not_member`. Canal fora disso → 404 genérico em `ler_mensagens` e `enviar_mensagem`; a `buscar` e o `listar_canais` simplesmente não os incluem; arquivos de canais invisíveis também não aparecem.
- `POST /messages` → `MessageDTO` (201), autor = agente, `jobId` = job atual, `onBehalfOfUserId` = quem pediu o job. `channel` aceita id, nome ou `#nome`; `toUser` aceita e-mail, nome exato, handle de pessoa ou parte única do nome (ambíguo → 400 `ambiguous_user`). DM com pessoa notifica (`dm`); `@pessoa` notifica (`mention`); `@agente` só registra a menção (não dispara job — use `consultar_agente`).
- `GET /messages` → `{ channel: { id, name, kind }, items: (MessageDTO & { authorName })[] }` (mais antigas primeiro; `before` em ms; `threadRootId` opcional).
- `GET /channels` → `{ items: { id, kind, name, title, section, topic, isPrivate, isMember }[] }`.
- `GET /search` → `SearchResultsDTO`; tarefas, wiki e arquivos só entram se o agente tem `read` neles.
- `POST /memories` `{ scope, content, source? }` → `MemoryDTO` (201). `GET /memories` → `{ items: { id, scope, content, source, updatedAt }[] }` (as próprias + as do time). `DELETE /memories/:id` → `{ ok: true, id }` (só a própria ou do time).
- `GET /tasks` → `{ items: TaskDTO[] }` (`assignee` = handle do agente, nome/e-mail da pessoa, `me` ou `none`; `status` aceita lista). `POST /tasks` → `TaskDTO` (201). `PATCH /tasks/:numero` → `TaskDTO` (`assigneeAgent: null`/`""` tira o responsável). `POST /tasks/:numero/comments` → `TaskCommentDTO` (201). Ações gravam `onBehalfOfUserId`.
- `GET /wiki` → `{ items: { id, title, parentId, isFolder, version, updatedAt }[] }`. `GET /wiki/:idOuTitulo` → `WikiPageDTO` (registra leitura do agente). `PUT /wiki` → `WikiPageDTO & { created: boolean }` (201 se criou; com `id` atualiza; sem `id` atualiza a página de mesmo título, ignorando maiúsculas e mantendo o título original; `parentTitle` inexistente vira pasta nova).
- `GET /files` → `{ items: FileDTO[] }`; `GET /files/:id/content` → stream (como na rota de pessoas); `POST /files` → `FileDTO` (201).
- `GET /team` → `{ people: { name, email, handle, role, title, sector }[], agents: { handle, name, role, description, sector, isAssistant, status, isMe, canConsult }[] }`.
- `POST /agents/:handle/ask` `{ prompt }` → sempre 200 `{ text, status, jobId, agent: { handle, name }, note? }` quando a consulta foi aceita; `status`: `done` | `failed` | `cancelled` | `timeout` (espera até 25 min) | `no_runner` (nenhum runner pegou o job filho em 90 s — por exemplo, nenhum runner online tem a CLI preferida do alvo; o filho é cancelado). Regras: alvo com `agentsCanConsult`; chamador com `callableAgentsMode` `all` ou `only` com o alvo na lista; nunca o próprio agente nem assistente de outra pessoa; sem ciclo (alvo já na cadeia de jobs pais → 409 `consult_cycle`); no máximo 3 níveis (409 `consult_depth`); alvo pausado/sem orçamento → 409. O job filho tem `origin = 'agent'`, `parentJobId`, `requestedByUserId` do pai e nenhum canal; vai primeiro para o runner do pai. Se o job pai deixa de rodar, a espera para e o filho é cancelado.
- `POST /approvals` → `ApprovalDTO` (201; `kind = 'action'`, `jobId` = job atual, aprovador = responsável). `GET /approvals/:id` → `ApprovalDTO` (só as do próprio agente).
- `POST /agents` e `POST /routines`: só assistente pessoal (`isAssistant`) em job pedido pelo dono (ou sem pedido humano); senão 403 `assistant_only`. Agente criado tem o dono do assistente como responsável → `AgentDTO` (201). Rotina: agente alvo do qual o dono é responsável (ou o dono é admin); `channel` precisa ser visível ao dono e não `humansOnly`; sem `channel`: o canal do job (se o alvo é o próprio assistente) ou a DM dono↔alvo → `RoutineDTO` (201).
- `POST /progress` `{ summary }` → `{ ok: true, event: JobEventDTO }` (201), grava `job_events` (`note`) e emite `job.event`.

## Servidor MCP do hub

`POST /api/workspaces/:ws/mcp` (Streamable HTTP, token pessoal). Permite que Claude, Cursor etc. usem o workspace: `listar_agentes`, `criar_agente`, `pedir_ao_agente` (cria job e devolve a resposta), `criar_rotina`, `criar_tarefa`, `listar_tarefas`, `buscar`. Age com as permissões da pessoa dona do token.

Implementação: servidor **sem estado**, JSON-RPC 2.0 à mão (sem SDK), respostas `application/json` (sem SSE). Métodos: `initialize` (devolve a `protocolVersion` pedida se for `2025-06-18`, `2025-03-26` ou `2024-11-05`; senão `2025-06-18`), `ping`, `tools/list`, `tools/call` (resultado em `content[0].text` como JSON e em `structuredContent`; erro de negócio → `isError: true` com a mensagem). Notificações (sem `id`) → 202 sem corpo. Lotes (array) são aceitos, de 1 a 20 itens (senão 400). `GET`/`DELETE /mcp` → 405. Token de runner → 403. `pedir_ao_agente` `{ handle, prompt, aguardarSegundos? }` publica o pedido como mensagem da pessoa na DM com o agente, cria o job (com as checagens de pausa/acesso/orçamento) e espera até `aguardarSegundos` (padrão 120, máx. 600) → `{ status, text, jobId, channelId, note? }`. `criar_tarefa` aceita `assigneeAgent` (handle) ou `assigneeUserEmail`. Exemplo de configuração no Claude Code: `claude mcp add --transport http puxibot <hub>/api/workspaces/<ws>/mcp --header "Authorization: Bearer tb_..."`.

## Configuração do Worker

Bindings: `DB` (D1), `FILES` (R2), `WORKSPACE_HUB` (Durable Object, classe SQLite), `ASSETS` (interface web), `AI` (opcional, só em produção).
Segredos/variáveis: `JOB_TOKEN_SECRET`, `SECRETS_KEY` (AES-GCM, base64 de 32 bytes), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` (opcional; sem ele o hub usa `getMe`), `PUBLIC_URL`. Os de push e Telegram são opcionais; sem eles o recurso fica desligado, sem erro. Par VAPID: `npm run vapid -w @puxibot/hub` (chave pública = ponto P-256 não comprimido em base64url, privada = 32 bytes em base64url).
Cron do Worker: `*/30 * * * *` (`triggers.crons`), rede de segurança das rotinas.
`wrangler dev` precisa funcionar sem login na Cloudflare.

Notas de implementação do hub:

- **Segredos fracos**: fora de localhost o hub recusa qualquer requisição `/api/*` (500 `insecure_config`, mensagem explica qual) se `JOB_TOKEN_SECRET` faltar, tiver menos de 32 caracteres ou for um valor de teste conhecido, ou se `SECRETS_KEY` não for base64 de 32 bytes aleatórios. Em localhost (dev e testes) passa.
- O cron do Worker também apaga janelas antigas de `rate_limits` e pareamentos vencidos.

- `npm run dev -w @puxibot/hub` (e `db:migrate`) roda antes `scripts/dev-setup.mjs`, que cria `apps/hub/.dev.vars` com `JOB_TOKEN_SECRET` e `SECRETS_KEY` aleatórios e um placeholder em `apps/web/dist` se a interface ainda não foi compilada. Em produção: `wrangler secret put JOB_TOKEN_SECRET` e `wrangler secret put SECRETS_KEY` (base64 de 32 bytes, ex.: `openssl rand -base64 32`), e `PUBLIC_URL` em `vars`.
- Links de notificação (`NotificationDTO.link`), nas rotas em português da interface: `/w/<ws>/c/<channelId>`, `/w/<ws>/equipe?agente=<agentId>`, `/w/<ws>/aprovacoes`, `/w/<ws>/tarefas?tarefa=<número>` (a tela de tarefas aceita em `tarefa` o número ou o id). Convite: `<PUBLIC_URL ou origem>/convite/<code>`. Pareamento: `<PUBLIC_URL ou origem>/parear?code=<pairCode>`.
- Migração `0003_second_wave.sql`: `members.sector_id`; `on_behalf_of_user_id` em `messages`, `tasks`, `task_comments`, `memories`, `files` (DTOs ganham `onBehalfOfUserId`); `jobs.task_id` e `jobs.waiting_for_runner`; `runners.token_id`; índices.
- Ações de agente pela API de ferramentas gravam `onBehalfOfUserId` = `requestedByUserId` do job (mensagens, tarefas, comentários, memórias, arquivos, wiki).
- Runner: `{"type":"ping"}` recebe `{"type":"pong"}`; o navegador pode mandar `ping` como keepalive (sem resposta).
- Job: o aviso `no_runner` sai uma vez por job (coluna `jobs.no_runner_notified_at`, migração `0002`) para quem pediu, ou para o responsável quando não há pedido humano.
