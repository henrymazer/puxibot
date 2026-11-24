import { BROWSER_TOOL, type JobAssignment, type JobContextMessage, type ToolLevel } from "@puxibot/shared";
import { JOB_CONTEXT_MESSAGES, JOB_TIMEOUT_MS, type AppEnv } from "../env";
import { all, first, parseJson } from "../lib/db";
import { decryptJson } from "../lib/crypto";
import { issueJobToken } from "../lib/jobToken";
import { JOB_LEASE_MS } from "@puxibot/shared";
import { requireAgentRow, toolPerms } from "./agents";
import { getChannel } from "./channels";
import { freshAccessToken } from "./connectorOauth";
import { usableVaultItems } from "../routes/extras";
import type { ConnectorRow, JobRow, MessageRow } from "./rows";


/** Chave para o runner retomar a sessão da CLI: mesmo agente + mesmo canal/thread. */
export function sessionKey(job: Pick<JobRow, "agent_id" | "channel_id" | "thread_root_id">): string {
  return `${job.agent_id}:${job.channel_id ?? "none"}:${job.thread_root_id ?? "main"}`;
}

/** Monta tudo que o runner precisa para executar o job, a partir das tabelas. */
export async function buildAssignment(env: AppEnv, job: JobRow, hubUrl: string): Promise<JobAssignment> {
  const db = env.DB;
  const wsId = job.workspace_id;
  const [workspace, agent, perms] = await Promise.all([
    first<{ id: string; name: string }>(db, "SELECT id, name FROM workspaces WHERE id = ?", wsId),
    requireAgentRow(db, wsId, job.agent_id),
    toolPerms(db, job.agent_id),
  ]);

  const [skills, memories, teammates, requester, channel] = await Promise.all([
    all<{ name: string; description: string; body: string; kind: string | null }>(
      db,
      `SELECT s.name, s.description, s.body, s.kind FROM skills s JOIN agent_skills x ON x.skill_id = s.id
       WHERE s.workspace_id = ? AND x.agent_id = ? ORDER BY s.name`,
      wsId,
      job.agent_id,
    ),
    all<{ scope: "agent" | "team"; content: string; id: string; source: string; status: string | null }>(
      db,
      `SELECT scope, content, id, source, status FROM memories
       WHERE workspace_id = ? AND (scope = 'team' OR (scope = 'agent' AND agent_id = ?))
       ORDER BY updated_at DESC LIMIT 200`,
      wsId,
      job.agent_id,
    ),
    all<{ handle: string; name: string; role: string | null }>(
      db,
      "SELECT handle, name, role FROM agents WHERE workspace_id = ? AND id <> ? ORDER BY name COLLATE NOCASE",
      wsId,
      job.agent_id,
    ),
    job.requested_by_user_id
      ? first<{ id: string; name: string }>(db, "SELECT id, name FROM users WHERE id = ?", job.requested_by_user_id)
      : Promise.resolve(null),
    job.channel_id ? getChannel(db, wsId, job.channel_id) : Promise.resolve(null),
  ]);

  // Conectores liberados (connector:<id> com nível diferente de none), com segredos decifrados — só os do dono
  // do runner que vai executar: segredos (e o `command` de conector stdio, que roda na máquina do runner) nunca
  // vão para a máquina de outra pessoa.
  const runnerUserId = job.runner_user_id;
  const connectorLevels = Object.entries(perms)
    .filter(([tool, level]) => tool.startsWith("connector:") && level !== "none")
    .map(([tool, level]) => ({ id: tool.slice("connector:".length), level }));
  const connectors: JobAssignment["connectors"] = [];
  for (const { id, level } of connectorLevels) {
    const row = await first<ConnectorRow>(db, "SELECT * FROM connectors WHERE workspace_id = ? AND id = ?", wsId, id);
    if (!row || !runnerUserId || row.owner_user_id !== runnerUserId) continue;
    let secrets: { headers?: Record<string, string>; env?: Record<string, string> } = {};
    if (row.secrets_enc) {
      try {
        secrets = await decryptJson(env.SECRETS_KEY, row.secrets_enc);
      } catch (err) {
        console.error(JSON.stringify({ msg: "connector secrets decrypt failed", connectorId: row.id, error: String(err) }));
      }
    }
    const headers = { ...(secrets.headers ?? {}) };
    if (row.auth === "oauth") {
      // Login pelo navegador: o runner recebe só um token de acesso recém-conferido; a renovação fica no hub.
      const token = await freshAccessToken(env, row);
      if (!token) continue; // sem login válido: o agente trabalha sem este conector
      headers.Authorization = `Bearer ${token}`;
    }
    connectors.push({
      id: row.id,
      name: row.name,
      transport: row.transport,
      url: row.url,
      command: row.command,
      args: parseJson<string[]>(row.args_json, []),
      headers,
      env: secrets.env ?? {},
      level: level as ToolLevel,
    });
  }

  // Logins do cofre que o navegador pode usar neste trabalho: só nomes e sites.
  const vault =
    (perms[BROWSER_TOOL] ?? "none") === "none"
      ? []
      : (
          await usableVaultItems(db, wsId, job, agent)
        ).map((i) => ({ name: i.name, origin: i.origin }));

  // Canal só de humanos nunca vai como contexto para agente (mesmo que tenha virado humansOnly depois do pedido).
  const context = channel && channel.humans_only !== 1 ? await contextMessages(db, wsId, job) : [];
  const now = Date.now();
  const jobToken = await issueJobToken(env.JOB_TOKEN_SECRET, {
    jobId: job.id,
    agentId: job.agent_id,
    workspaceId: wsId,
    exp: now + JOB_TIMEOUT_MS + JOB_LEASE_MS,
  });

  return {
    jobId: job.id,
    jobToken,
    hubUrl,
    workspace: { id: wsId, name: workspace?.name ?? "" },
    agent: {
      id: agent.id,
      handle: agent.handle,
      name: agent.name,
      role: agent.role,
      instructions: agent.instructions,
      isAssistant: agent.is_assistant === 1,
      preferredCli: agent.preferred_cli,
      preferredModel: agent.preferred_model,
      toolPerms: perms,
      skills: skills.map((s) => ({ name: s.name, description: s.description, body: s.body, ...(s.kind === "learned" ? { learned: true } : {}) })),
      learnSkills: agent.learn_skills !== 0,
      systemKind: agent.system_kind === "builder" ? "builder" : null,
    },
    mode: job.mode ?? null,
    replyVia: job.reply_via ?? null,
    origin: job.origin,
    parentJobId: job.parent_job_id,
    requestedBy: requester ? { userId: requester.id, name: requester.name } : null,
    channel: channel ? { id: channel.id, kind: channel.kind, name: channel.name } : null,
    threadRootId: job.thread_root_id,
    prompt: job.prompt,
    context,
    // A revisão automática só apaga o que não foi escrito por uma pessoa.
    memories: memories.map((m) => ({
      scope: m.scope,
      content: m.content,
      id: m.id,
      removable: m.source !== "user",
      ...(m.status === "tentative" ? { tentative: true } : {}),
    })),
    teammates,
    connectors,
    vault,
    sessionKey: sessionKey(job),
    timeoutMs: JOB_TIMEOUT_MS,
  };
}

/** Últimas mensagens do canal (ou da thread) antes do pedido, mais antigas primeiro. */
async function contextMessages(db: D1Database, wsId: string, job: JobRow): Promise<JobContextMessage[]> {
  let before = Number.MAX_SAFE_INTEGER;
  if (job.trigger_message_id) {
    const trigger = await first<{ created_at: number }>(
      db,
      "SELECT created_at FROM messages WHERE workspace_id = ? AND id = ?",
      wsId,
      job.trigger_message_id,
    );
    if (trigger) before = trigger.created_at;
  }
  const rows = job.thread_root_id
    ? await all<MessageRow>(
        db,
        `SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ? AND (id = ? OR thread_root_id = ?)
           AND deleted_at IS NULL AND created_at <= ? AND id <> ?
         ORDER BY created_at DESC LIMIT ?`,
        wsId,
        job.channel_id,
        job.thread_root_id,
        job.thread_root_id,
        before,
        job.trigger_message_id ?? "",
        JOB_CONTEXT_MESSAGES,
      )
    : await all<MessageRow>(
        db,
        `SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ? AND thread_root_id IS NULL
           AND deleted_at IS NULL AND created_at <= ? AND id <> ?
         ORDER BY created_at DESC LIMIT ?`,
        wsId,
        job.channel_id,
        before,
        job.trigger_message_id ?? "",
        JOB_CONTEXT_MESSAGES,
      );
  rows.reverse();
  const userIds = [...new Set(rows.filter((r) => r.author_type === "user" && r.author_id).map((r) => r.author_id!))];
  const agentIds = [...new Set(rows.filter((r) => r.author_type === "agent" && r.author_id).map((r) => r.author_id!))];
  const names = new Map<string, string>();
  for (const id of userIds) {
    const u = await first<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", id);
    if (u) names.set(`user:${id}`, u.name);
  }
  for (const id of agentIds) {
    const a = await first<{ name: string }>(db, "SELECT name FROM agents WHERE workspace_id = ? AND id = ?", wsId, id);
    if (a) names.set(`agent:${id}`, a.name);
  }
  return rows.map((r) => ({
    author: r.author_type === "system" ? "Sistema" : (names.get(`${r.author_type}:${r.author_id}`) ?? "Desconhecido"),
    authorType: r.author_type,
    body: r.body,
    createdAt: r.created_at,
  }));
}
