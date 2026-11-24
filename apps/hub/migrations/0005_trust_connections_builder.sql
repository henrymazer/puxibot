-- Terceira leva: checagem de permissão no hub, catálogo e login OAuth de conectores, agente criador,
-- memória com citação, skills aprendidas, registro de ações, canais de conversa, cofre e preparação automática.

-- ---------- Agentes ----------
-- Ações que mudam algo num conector ou no navegador: 'ask' = só com cobertura (pedido, regra ou aprovação);
-- 'auto' = roda sem perguntar (comportamento antigo, agora escolha explícita do responsável).
ALTER TABLE agents ADD COLUMN trust_mode TEXT NOT NULL DEFAULT 'ask';
-- 'builder' = agente criador (monta canais, agentes e rotinas a partir de uma conversa). NULL nos demais.
ALTER TABLE agents ADD COLUMN system_kind TEXT;
-- 1 = guarda procedimentos aprendidos ao fim de um trabalho.
ALTER TABLE agents ADD COLUMN learn_skills INTEGER NOT NULL DEFAULT 1;

-- ---------- Conectores ----------
ALTER TABLE connectors ADD COLUMN catalog_id TEXT;                       -- receita do catálogo (ex.: 'meta-ads'), NULL = personalizado
ALTER TABLE connectors ADD COLUMN auth TEXT NOT NULL DEFAULT 'static';   -- 'static' (cabeçalhos/variáveis) | 'oauth'
ALTER TABLE connectors ADD COLUMN oauth_enc TEXT;                        -- estado OAuth cifrado (cliente registrado, tokens, expiração)
ALTER TABLE connectors ADD COLUMN oauth_status TEXT;                     -- 'pending' | 'connected' | 'signin_required'
ALTER TABLE connectors ADD COLUMN oauth_client_id TEXT;                  -- quando o serviço exige um cliente pré-registrado
ALTER TABLE connectors ADD COLUMN oauth_scope TEXT;

-- Login OAuth em andamento. `state` nunca fica em claro; expira em 10 minutos.
CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY,           -- sha256 hex do `state`
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_enc TEXT NOT NULL,               -- estado do fluxo (verificador PKCE, cliente) cifrado
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ---------- Checagem de permissão ----------
-- Regra do responsável: o que um agente pode fazer num conector sem perguntar.
CREATE TABLE trust_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,            -- id do conector, ou 'browser'
  tool TEXT NOT NULL,                    -- nome da ferramenta, ou '*'
  effect TEXT NOT NULL,                  -- 'allow' | 'ask' | 'deny'
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, connector_id, tool)
);

-- Cada chamada a um conector ou ao navegador, com o motivo que a liberou.
CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  connector_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',      -- argumentos resumidos, sem segredos
  kind TEXT NOT NULL,                    -- 'read' | 'write'
  decision TEXT NOT NULL,                -- 'allowed' | 'asked' | 'denied'
  reason TEXT NOT NULL,                  -- por que foi liberada (ou negada)
  approval_id TEXT,
  status TEXT NOT NULL,                  -- 'pending' | 'ok' | 'error' | 'blocked'
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_agent_actions_job ON agent_actions(job_id, created_at);
CREATE INDEX idx_agent_actions_ws ON agent_actions(workspace_id, created_at);

-- Aprovação de uma ação de conector: a que ação se refere e o alcance da resposta.
ALTER TABLE approvals ADD COLUMN action_id TEXT;
ALTER TABLE approvals ADD COLUMN scope TEXT;                             -- 'once' | 'job' | 'always'

-- "Aprovar neste trabalho": escritas no mesmo conector deixam de perguntar até o trabalho acabar.
CREATE TABLE job_grants (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, connector_id)
);

-- ---------- Jobs ----------
-- 'prepare' = preparação automática: só lê e rascunha, nunca altera um conector.
ALTER TABLE jobs ADD COLUMN mode TEXT;
-- Pedido que chegou por um canal de conversa externo: a resposta volta por ele.
ALTER TABLE jobs ADD COLUMN reply_via TEXT;                              -- 'telegram' | 'whatsapp'
ALTER TABLE jobs ADD COLUMN reply_to TEXT;                               -- chat_id ou número

-- ---------- Memória ----------
-- 'tentative' = escrita por um agente sem citação conferida das palavras de uma pessoa.
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE memories ADD COLUMN quote TEXT;                              -- trecho literal da mensagem que a sustenta
ALTER TABLE memories ADD COLUMN source_message_id TEXT;

-- ---------- Skills ----------
ALTER TABLE skills ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';       -- 'manual' | 'learned'
ALTER TABLE skills ADD COLUMN agent_id TEXT;                             -- learned: agente que aprendeu
ALTER TABLE skills ADD COLUMN source_job_id TEXT;

-- ---------- Agente criador ----------
CREATE TABLE setup_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,                -- agente criador que propôs
  job_id TEXT,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'applied' | 'discarded'
  result_json TEXT,                      -- o que foi criado e o que ficou pendente
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER
);
CREATE INDEX idx_setup_plans_user ON setup_plans(workspace_id, user_id, updated_at);

-- ---------- Canais de conversa (Telegram, WhatsApp) ----------
CREATE TABLE chat_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                -- 'telegram' | 'whatsapp'
  external_id TEXT,                      -- chat_id ou número; NULL até a pessoa mandar o código
  link_code TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, provider),
  UNIQUE (provider, external_id)
);

-- ---------- Cofre ----------
-- Logins de sites. O hub só entrega a senha ao intermediário do navegador, no computador do dono.
CREATE TABLE vault_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,                  -- protocolo + host + porta, ex.: https://app.exemplo.com
  username TEXT NOT NULL,
  secret_enc TEXT NOT NULL,              -- { password } cifrado
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (workspace_id, owner_user_id, name)
);
