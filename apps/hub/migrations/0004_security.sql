-- Revisão de segurança do hub: limite de tentativas (login, cadastro, pareamento).
-- Janela fixa por chave (ex.: "login:email:<e-mail>", "login:ip:<ip>"); linhas antigas são apagadas pelo cron do Worker.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,         -- início da janela atual (ms)
  count INTEGER NOT NULL                 -- tentativas dentro da janela
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
