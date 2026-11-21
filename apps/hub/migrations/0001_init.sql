-- Timebot hub: schema inicial (D1 / SQLite).
-- Convenções: ids são texto (UUID v4, exceto onde indicado); datas são INTEGER em ms desde epoch;
-- colunas *_json guardam JSON serializado; toda tabela de domínio tem workspace_id e toda consulta filtra por ele.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- "pbkdf2$<iter>$<salt_b64>$<hash_b64>"
  avatar_color TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                  -- valor do cookie "tb_session" (aleatório, 32 bytes hex)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Tokens pessoais: usados pelo runner, por scripts e pelo servidor MCP do hub.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal', -- 'personal' | 'runner'
  token_hash TEXT NOT NULL UNIQUE,       -- sha256 hex do token "tb_<...>"
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'team',     -- 'personal' | 'team'
  business TEXT,                         -- área de atuação do time
  router_enabled INTEGER NOT NULL DEFAULT 0,
  task_seq INTEGER NOT NULL DEFAULT 0,   -- último número de tarefa usado
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                    -- 'owner' | 'admin' | 'member'
  title TEXT,                            -- cargo livre
  status_text TEXT,                      -- ex.: "Em reunião"
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,                   -- também é o código do link
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sectors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lead_user_id TEXT REFERENCES users(id)
);

-- ---------- Agentes ----------
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,                  -- usado em @menção; minúsculas, [a-z0-9_-]
  name TEXT NOT NULL,
  role TEXT,                             -- função: "Engenharia", "PM"...
  description TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  avatar_color TEXT,
  avatar_accessory TEXT,
  sector_id TEXT REFERENCES sectors(id) ON DELETE SET NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),   -- responsável
  is_assistant INTEGER NOT NULL DEFAULT 0,            -- 1 = assistente pessoal do owner (age com as permissões dele)
  access_mode TEXT NOT NULL DEFAULT 'workspace',      -- 'workspace' | 'restricted' | 'owner'
  agents_can_consult INTEGER NOT NULL DEFAULT 1,      -- outros agentes podem consultá-lo
  callable_agents_mode TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'only' | 'none'
  callable_agents_json TEXT NOT NULL DEFAULT '[]',    -- ids, quando mode = 'only'
  preferred_cli TEXT,                                 -- 'claude' | 'codex' | 'gemini' | NULL (o do runner)
  preferred_model TEXT,
  budget_tokens_month INTEGER,                        -- NULL = sem limite
  budget_runs_month INTEGER,
  budget_warned_period TEXT,                          -- 'YYYY-MM' em que o aviso de 80% já foi enviado
  self_start_policy TEXT NOT NULL DEFAULT 'ask',      -- trabalho que ninguém pediu: 'ask' | 'run'
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
  max_prs_per_hour INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'active',              -- 'active' | 'paused'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, handle)
);

-- Quem pode falar com o agente quando access_mode = 'restricted'.
CREATE TABLE agent_access (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, user_id)
);

-- Permissão por ferramenta. tool = nativa ('memory','drive','tasks','wiki','messages','agents') ou 'connector:<id>'.
CREATE TABLE agent_tool_perms (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  level TEXT NOT NULL,                   -- 'none' | 'read' | 'write'
  PRIMARY KEY (agent_id, tool)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,                    -- conteúdo markdown (SKILL.md)
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE agent_skills (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

-- Memória: scope 'agent' (individual) ou 'team' (compartilhada no workspace).
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,                   -- 'agent' | 'team'
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',  -- 'agent' | 'user' | 'extraction'
  created_by_type TEXT NOT NULL,         -- 'user' | 'agent'
  created_by_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_ws ON memories(workspace_id, scope, agent_id);

-- Conectores externos (servidores MCP) do workspace.
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,               -- 'http' | 'stdio'
  url TEXT,                              -- http
  command TEXT,                          -- stdio
  args_json TEXT NOT NULL DEFAULT '[]',
  secrets_enc TEXT,                      -- JSON {headers?, env?} cifrado com AES-GCM (chave SECRETS_KEY)
  owner_user_id TEXT NOT NULL REFERENCES users(id),   -- só o dono concede acesso
  created_at INTEGER NOT NULL
);

-- ---------- Chat ----------
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- 'channel' | 'dm'
  name TEXT,                             -- NULL em DM
  section TEXT,                          -- agrupamento na barra lateral ("Marketing", "Tech")
  topic TEXT,
  humans_only INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  dm_key TEXT,                           -- DM: participantes ordenados "u:<id>|a:<id>"; único por workspace
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER,
  UNIQUE (workspace_id, dm_key)
);
CREATE INDEX idx_channels_ws ON channels(workspace_id, kind);

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL,             -- 'user' | 'agent'
  member_id TEXT NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, member_type, member_id)
);
CREATE INDEX idx_channel_members_member ON channel_members(member_type, member_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,             -- 'user' | 'agent' | 'system'
  author_id TEXT,                        -- NULL em 'system'
  body TEXT NOT NULL,                    -- markdown
  thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  quote_json TEXT,                       -- {messageId, text} quando cita um trecho
  attachments_json TEXT NOT NULL DEFAULT '[]',   -- [{fileId,name,mime,size}]
  cards_json TEXT NOT NULL DEFAULT '[]',         -- cartões ricos: ver MessageCard em @timebot/shared
  mentions_json TEXT NOT NULL DEFAULT '[]',      -- [{type:'user'|'agent', id}]
  job_id TEXT,                           -- execução que gerou a mensagem (agente)
  meta_json TEXT,                        -- agente: {cli, model, runnerUserId, runnerName}
  pinned INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX idx_messages_thread ON messages(thread_root_id);

CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,                   -- inclui '👍'/'👎' usados como avaliação de resposta de agente
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- ---------- Execução ----------
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- nome da máquina
  platform TEXT,
  clis_json TEXT NOT NULL DEFAULT '[]',  -- [{cli:'claude', version, loggedIn}]
  isolation TEXT,                        -- 'sandbox' | 'container' | 'none'
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_runners_ws ON runners(workspace_id, user_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,   -- onde a resposta é publicada
  thread_root_id TEXT,
  trigger_message_id TEXT,
  origin TEXT NOT NULL,                  -- 'user' | 'routine' | 'agent' | 'system'
  requested_by_user_id TEXT,             -- pessoa que pediu (origin = 'user')
  parent_job_id TEXT,                    -- origin = 'agent'
  routine_id TEXT,
  prompt TEXT NOT NULL,                  -- pedido em texto
  status TEXT NOT NULL,                  -- 'awaiting_approval' | 'queued' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled'
  runner_id TEXT,
  runner_user_id TEXT,                   -- de quem é a assinatura usada
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  cli TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  result_text TEXT,
  error TEXT,
  error_code TEXT,                       -- 'auth' | 'limit' | 'timeout' | 'runner_lost' | 'error'
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX idx_jobs_ws_status ON jobs(workspace_id, status);
CREATE INDEX idx_jobs_agent ON jobs(agent_id, created_at);

-- Eventos de atividade de uma execução (ferramentas usadas, etc.), para a aba "Atividade".
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- 'tool' | 'status' | 'note'
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_job_events_job ON job_events(job_id);

CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,                    -- 5 campos, no fuso `timezone`
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,   -- onde publicar
  enabled INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'custom',   -- 'custom' | 'daily_summary'
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_routines_next ON routines(workspace_id, enabled, next_run_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- 'job_start' (trabalho que ninguém pediu) | 'action' (ação sensível pedida pelo agente)
  title TEXT NOT NULL,
  details TEXT,
  approver_user_id TEXT NOT NULL REFERENCES users(id),   -- responsável pelo agente
  status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'approved' | 'rejected'
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_approvals_approver ON approvals(workspace_id, approver_user_id, status);

-- ---------- Tarefas ----------
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,               -- sequencial por workspace (#210)
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',   -- 'todo' | 'doing' | 'review' | 'done'
  priority TEXT NOT NULL DEFAULT 'medium',  -- 'low' | 'medium' | 'high'
  labels_json TEXT NOT NULL DEFAULT '[]',
  project TEXT,
  assignee_type TEXT,                    -- 'user' | 'agent' | NULL
  assignee_id TEXT,
  subtasks_json TEXT NOT NULL DEFAULT '[]',  -- [{id,title,done}]
  links_json TEXT NOT NULL DEFAULT '[]',     -- [{kind:'pr'|'issue'|'url', label, url}]
  source_message_id TEXT,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,      -- ordem dentro da coluna
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,           -- usado para "Parado há N dias"
  UNIQUE (workspace_id, number)
);
CREATE INDEX idx_tasks_ws_status ON tasks(workspace_id, status);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------- Wiki ----------
CREATE TABLE wiki_pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  is_folder INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',         -- markdown
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,                    -- lixeira
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  updated_by_type TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  on_behalf_of_user_id TEXT,             -- "Tito, em nome de Renato"
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wiki_ws ON wiki_pages(workspace_id, parent_id);

CREATE TABLE wiki_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  on_behalf_of_user_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);

-- Leituras de página, para "agentes que usam esta página" e "consultas na semana".
CREATE TABLE wiki_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  reader_type TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_wiki_reads_page ON wiki_reads(page_id, created_at);

-- ---------- Drive ----------
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  folder TEXT,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  in_drive INTEGER NOT NULL DEFAULT 1,   -- 0 = só anexo de mensagem
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_files_ws ON files(workspace_id, created_at);

-- ---------- Notificações ----------
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- 'mention' | 'dm' | 'approval' | 'budget' | 'job_failed' | 'no_runner'
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                             -- caminho na interface web
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(workspace_id, user_id, read_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Telegram: só avisos sem conteúdo.
CREATE TABLE telegram_links (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT,                          -- preenchido quando a pessoa envia /start <link_code> ao bot
  link_code TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
