-- Pareamento de runner sem copiar token à mão (POST /api/runner/pair/*). Expira em 10 minutos.
-- workspace_id/user_id ficam NULL até alguém aprovar; o token emitido fica cifrado (SECRETS_KEY)
-- até o runner buscá-lo uma vez pelo poll, quando a linha é apagada.
CREATE TABLE runner_pairings (
  pair_code TEXT PRIMARY KEY,            -- ex.: "K7QM-4XPA", mostrado ao usuário
  poll_token_hash TEXT NOT NULL UNIQUE,  -- sha256 hex do pollToken "tbp_<...>"
  name TEXT NOT NULL,                    -- nome da máquina informado pelo runner
  status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'approved'
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  token_enc TEXT,                        -- token de runner cifrado
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Aviso "nenhum runner online" enviado uma única vez por job.
ALTER TABLE jobs ADD COLUMN no_runner_notified_at INTEGER;
