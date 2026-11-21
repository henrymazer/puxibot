-- Segunda leva do hub: setor de pessoa, autoria "em nome de", jobs ligados a tarefas,
-- espera por runner e token do runner (para o runner remover o próprio registro).

-- Setor da pessoa (MemberDTO.sectorId).
ALTER TABLE members ADD COLUMN sector_id TEXT REFERENCES sectors(id) ON DELETE SET NULL;

-- "Tito, em nome de Renato": pessoa que pediu o job que gerou a ação do agente.
ALTER TABLE messages ADD COLUMN on_behalf_of_user_id TEXT;
ALTER TABLE tasks ADD COLUMN on_behalf_of_user_id TEXT;
ALTER TABLE task_comments ADD COLUMN on_behalf_of_user_id TEXT;
ALTER TABLE memories ADD COLUMN on_behalf_of_user_id TEXT;
ALTER TABLE files ADD COLUMN on_behalf_of_user_id TEXT;

-- Job criado a partir de uma tarefa (atribuição ou menção em comentário): a resposta vira comentário.
ALTER TABLE jobs ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
-- 1 = job `queued` sem nenhum runner elegível online (JobDTO.waitingForRunner). Mantido pelo WorkspaceHub.
ALTER TABLE jobs ADD COLUMN waiting_for_runner INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_jobs_parent ON jobs(parent_job_id);

-- Token de runner usado na última conexão (DELETE /runners/:id com o próprio token).
ALTER TABLE runners ADD COLUMN token_id TEXT;

CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);
CREATE INDEX idx_wiki_revisions_page ON wiki_revisions(page_id, version);
CREATE INDEX idx_files_folder ON files(workspace_id, in_drive, folder);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
CREATE INDEX idx_feedback_ws ON feedback(workspace_id, created_at);
