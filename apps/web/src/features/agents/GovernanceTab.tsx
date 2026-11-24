import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pause, Play, Trash2, TriangleAlert } from "lucide-react";
import { CLIS, type AgentDTO, type Cli, type RoutineDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import type { AgentPatch } from "../../api/client";
import { useWorkspace } from "../../store/workspace";
import { CLI_LABEL, canEditAgent, canPauseAgent, isAdmin, isOthersAssistant } from "../../lib/actors";
import { formatDateTime, formatNumber } from "../../lib/format";
import { describeCron } from "../../lib/cron";
import { cn } from "../../lib/cn";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Button, Card, ConfirmDialog, Field, InlineError, Input, LockedNote, Select, Toggle } from "../../components/ui";
import { toast } from "../../components/toast";
import { useWsId } from "../shell/hooks";
import { budgetPercent, Segmented, UsageBar, useAgentUsage, useSaveAgent } from "./shared";

type Draft = Pick<
  AgentDTO,
  | "ownerUserId"
  | "accessMode"
  | "allowedUserIds"
  | "agentsCanConsult"
  | "callableAgentsMode"
  | "callableAgentIds"
  | "budgetRunsMonth"
  | "budgetTokensMonth"
  | "selfStartPolicy"
  | "maxConcurrentJobs"
  | "maxPrsPerHour"
  | "preferredCli"
  | "preferredModel"
>;
const KEYS: (keyof Draft)[] = [
  "ownerUserId",
  "accessMode",
  "allowedUserIds",
  "agentsCanConsult",
  "callableAgentsMode",
  "callableAgentIds",
  "budgetRunsMonth",
  "budgetTokensMonth",
  "selfStartPolicy",
  "maxConcurrentJobs",
  "maxPrsPerHour",
  "preferredCli",
  "preferredModel",
];
const ADMIN_ONLY = new Set<keyof Draft>(["ownerUserId", "budgetRunsMonth", "budgetTokensMonth"]);

function pick(a: AgentDTO): Draft {
  return Object.fromEntries(KEYS.map((k) => [k, a[k]])) as Draft;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const ONLY_ADMINS = "Só admins mudam.";
const ONLY_OWNER = "Só o responsável ou um admin muda.";

export function GovernanceTab({ agent, onDeleted }: { agent: AgentDTO; onDeleted: () => void }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const admin = isAdmin(me?.role);
  const canEdit = canEditAgent(agent, me);
  const canPause = canPauseAgent(agent, me);
  /** Assistente pessoal de outra pessoa: admin só pausa e mexe no orçamento. */
  const othersAssistant = isOthersAssistant(agent, me);
  const seesBudget = admin || agent.ownerUserId === me?.userId;
  const [draft, setDraft] = useState<Draft>(() => pick(agent));
  const { save, saving, error } = useSaveAgent(ws, agent);
  const { usage, error: usageError, loading: usageLoading } = useAgentUsage(ws, agent.id, seesBudget);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const base = useMemo(() => pick(agent), [agent]);
  const changed = KEYS.filter((k) => !same(draft[k], base[k]));
  const dirty = changed.length > 0;
  // Quando o agente muda por fora e não há edição local, acompanha.
  useEffect(() => {
    if (!dirty) setDraft(pick(agent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggleIn = (k: "allowedUserIds" | "callableAgentIds", id: string) =>
    setDraft((d) => ({ ...d, [k]: d[k].includes(id) ? d[k].filter((x) => x !== id) : [...d[k], id] }));

  const submit = async () => {
    const patch: AgentPatch = {};
    for (const k of changed) {
      if (ADMIN_ONLY.has(k) && !admin) continue;
      if (othersAssistant && k !== "budgetRunsMonth" && k !== "budgetTokensMonth") continue;
      (patch as Record<string, unknown>)[k] = draft[k];
    }
    if (await save(patch, "Configurações salvas.")) setDraft(pick({ ...agent, ...patch } as AgentDTO));
  };

  const toggleStatus = async () => {
    setStatusBusy(true);
    await save({ status: agent.status === "paused" ? "active" : "paused" }, agent.status === "paused" ? `${agent.name} voltou a trabalhar.` : `${agent.name} foi pausado.`);
    setStatusBusy(false);
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteAgent(ws, agent.id);
      useWorkspace.getState().dispatch({ type: "agent.deleted", agentId: agent.id });
      toast.success(`${agent.name} foi apagado.`);
      onDeleted();
    } catch (e) {
      toast.error(e);
      setDeleting(false);
    }
  };

  const pct = budgetPercent({ ...agent, budgetRunsMonth: draft.budgetRunsMonth, budgetTokensMonth: draft.budgetTokensMonth }, usage);
  const humanList = Object.values(members).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const otherAgents = Object.values(agents).filter((a) => a.id !== agent.id);
  const editLock = canEdit ? null : ONLY_OWNER;

  const budgetCard = (
    <Card>
      <Heading title="Orçamento do mês" text="Conta execuções e tokens de todas as pessoas cujo computador executou o agente. O responsável recebe um aviso em 80%." />
      {!seesBudget ? (
        <LockedNote>Só admins e o responsável veem o orçamento.</LockedNote>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label="Execuções por mês" hint="Vazio = sem limite" value={draft.budgetRunsMonth} onChange={(v) => set("budgetRunsMonth", v)} disabled={!admin} />
            <NumberField label="Tokens por mês" hint="Vazio = sem limite" value={draft.budgetTokensMonth} onChange={(v) => set("budgetTokensMonth", v)} disabled={!admin} step={1000} />
          </div>
          {!admin && <LockedNote>{ONLY_ADMINS}</LockedNote>}
          {usageLoading ? (
            <p className="text-sm text-muted">Carregando uso…</p>
          ) : usageError ? (
            <InlineError message={usageError} />
          ) : usage ? (
            <div className="flex flex-col gap-3">
              {pct !== null ? (
                <UsageBar percent={pct} label={`${formatNumber(usage.runs)} execuções · ${formatNumber(usage.inputTokens + usage.outputTokens)} tokens`} />
              ) : (
                <p className="text-sm text-muted">
                  Sem limite. Neste mês: {formatNumber(usage.runs)} execuções e {formatNumber(usage.inputTokens + usage.outputTokens)} tokens.
                </p>
              )}
              {pct !== null && pct >= 80 && (
                <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {pct >= 100 ? "Orçamento esgotado: o agente não aceita novos pedidos até o mês virar." : "Passou de 80% do orçamento do mês."}
                </p>
              )}
              {usage.byRunnerUser.length > 0 && (
                <div>
                  <h4 className="mb-1 text-xs font-semibold text-muted">Por computador</h4>
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {usage.byRunnerUser.map((u) => (
                      <li key={u.userId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1">pelo computador de {members[u.userId]?.name ?? "pessoa removida"}</span>
                        <span className="text-xs text-muted">
                          {formatNumber(u.runs)} execuções · {formatNumber(u.tokens)} tokens
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );

  const pauseCard = (
    <Card>
      <Heading title={agent.status === "paused" ? "Agente pausado" : "Pausar agente"} text={agent.status === "paused" ? "Ele não responde nem começa trabalhos até voltar." : "Ele para de responder e de começar trabalhos. Nada é apagado."} />
      <div className="flex flex-wrap gap-2">
        <Button icon={agent.status === "paused" ? <Play className="size-4" /> : <Pause className="size-4" />} onClick={toggleStatus} loading={statusBusy} disabled={!canPause}>
          {agent.status === "paused" ? "Voltar a trabalhar" : "Pausar"}
        </Button>
        {!agent.isAssistant && (
          <Button variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)} disabled={!canEdit}>
            Apagar agente
          </Button>
        )}
      </div>
      {agent.isAssistant && <p className="mt-2 text-xs text-subtle">O assistente pessoal não pode ser apagado.</p>}
      {!canPause && <LockedNote>{ONLY_OWNER}</LockedNote>}
    </Card>
  );

  const saveBar = dirty && (canEdit || (othersAssistant && admin)) && (
    <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-elevated px-5 py-3">
      <span className="mr-auto text-xs text-warning">Alterações não salvas</span>
      <Button onClick={() => setDraft(pick(agent))} disabled={saving}>
        Descartar
      </Button>
      <Button variant="primary" onClick={() => void submit()} loading={saving}>
        Salvar
      </Button>
    </div>
  );

  if (othersAssistant) {
    const ownerName = members[agent.ownerUserId]?.name ?? "outra pessoa";
    const ownerFirst = ownerName.split(" ")[0];
    return (
      <div className="flex flex-col gap-4 pb-16">
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          Este é o assistente pessoal de {ownerName}. Ele age com as permissões de {ownerFirst} e roda no computador de {ownerFirst}; por isso, só {ownerFirst}{" "}
          configura instruções, acesso, ferramentas e rotinas. {admin ? "Como admin, você pode pausar e definir o orçamento." : ""}
        </p>
        {budgetCard}
        {pauseCard}
        <InlineError message={error} />
        {saveBar}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-16">
      {!canEdit && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          Você pode ver, mas só o responsável ({members[agent.ownerUserId]?.name ?? "—"}) ou um admin muda estas configurações.
        </p>
      )}

      <Card>
        <Heading title="Responsável" text="Recebe avisos de orçamento e aprova ações sensíveis." />
        <Field label="Pessoa responsável" hideLabel>
          {(id) => (
            <Select id={id} value={draft.ownerUserId} onChange={(e) => set("ownerUserId", e.target.value)} disabled={!admin || agent.isAssistant}>
              {humanList.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!admin && <LockedNote>{ONLY_ADMINS}</LockedNote>}
      </Card>

      <Card>
        <Heading title="Quem pode falar com o agente" />
        {agent.isAssistant ? (
          <LockedNote>O assistente pessoal só conversa com o dono.</LockedNote>
        ) : (
          <>
            <Segmented
              label="Quem pode falar"
              value={draft.accessMode}
              onChange={(v) => set("accessMode", v)}
              disabled={!canEdit}
              options={[
                { id: "workspace", label: "Todo o workspace" },
                { id: "restricted", label: "Algumas pessoas" },
                { id: "owner", label: "Só o responsável" },
              ]}
            />
            {draft.accessMode === "restricted" && (
              <fieldset className="mt-3" disabled={!canEdit}>
                <legend className="mb-1 text-sm font-medium">Pessoas que podem falar</legend>
                <CheckList>
                  {humanList.map((m) => (
                    <Check key={m.userId} checked={draft.allowedUserIds.includes(m.userId) || m.userId === draft.ownerUserId} disabled={m.userId === draft.ownerUserId} onChange={() => toggleIn("allowedUserIds", m.userId)}>
                      <PersonAvatar member={m} size="xs" />
                      {m.name}
                      {m.userId === draft.ownerUserId && <span className="text-xs text-subtle">(responsável)</span>}
                    </Check>
                  ))}
                </CheckList>
              </fieldset>
            )}
          </>
        )}
        {editLock && <LockedNote>{editLock}</LockedNote>}
        <div className="mt-4 border-t border-line pt-3">
          <Toggle
            label="Outros agentes podem consultar este"
            description="Permite que outro agente peça ajuda a ele no meio de um trabalho."
            checked={draft.agentsCanConsult}
            onChange={(v) => set("agentsCanConsult", v)}
            disabled={!canEdit}
          />
          <div className="mt-3">
            <span className="mb-1.5 block text-sm font-medium">Agentes que este pode chamar</span>
            <Segmented
              label="Agentes que este pode chamar"
              value={draft.callableAgentsMode}
              onChange={(v) => set("callableAgentsMode", v)}
              disabled={!canEdit}
              options={[
                { id: "all", label: "Todos" },
                { id: "only", label: "Só alguns" },
                { id: "none", label: "Nenhum" },
              ]}
            />
            {draft.callableAgentsMode === "only" && (
              <fieldset className="mt-2" disabled={!canEdit}>
                <legend className="sr-only">Escolha os agentes</legend>
                {otherAgents.length === 0 ? (
                  <p className="text-xs text-muted">Não há outros agentes.</p>
                ) : (
                  <CheckList>
                    {otherAgents.map((a) => (
                      <Check key={a.id} checked={draft.callableAgentIds.includes(a.id)} onChange={() => toggleIn("callableAgentIds", a.id)}>
                        <AgentAvatar agent={a} size="xs" />
                        {a.name}
                      </Check>
                    ))}
                  </CheckList>
                )}
              </fieldset>
            )}
          </div>
        </div>
      </Card>

      {budgetCard}

      <Card>
        <Heading title="Trabalho que ninguém pediu" text="O que o agente começa sozinho: rotinas, alertas ou pedidos de outro agente." />
        <Segmented
          label="Trabalho que ninguém pediu"
          value={draft.selfStartPolicy}
          onChange={(v) => set("selfStartPolicy", v)}
          disabled={!canEdit}
          options={[
            { id: "ask", label: "Pedir aprovação antes" },
            { id: "run", label: "Fazer direto" },
          ]}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <NumberField label="Trabalhos ao mesmo tempo" value={draft.maxConcurrentJobs} onChange={(v) => set("maxConcurrentJobs", Math.max(1, v ?? 1))} disabled={!canEdit} min={1} max={20} />
          <NumberField label="Pull requests por hora" value={draft.maxPrsPerHour} onChange={(v) => set("maxPrsPerHour", Math.max(0, v ?? 0))} disabled={!canEdit} min={0} max={100} />
        </div>
        {editLock && <LockedNote>{editLock}</LockedNote>}
      </Card>

      {agent.systemKind !== "builder" && <ProactiveCard agent={agent} />}

      <Card>
        <Heading title="CLI e modelo preferidos" text="Usados quando o computador que executa tiver essa CLI. Senão, vale a que estiver disponível." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CLI">
            {(id) => (
              <Select id={id} value={draft.preferredCli ?? ""} onChange={(e) => set("preferredCli", (e.target.value || null) as Cli | null)} disabled={!canEdit}>
                <option value="">Automático</option>
                {CLIS.map((c) => (
                  <option key={c} value={c}>
                    {CLI_LABEL[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Modelo" hint="Vazio = o padrão da CLI.">
            {(id, d) => <Input id={id} aria-describedby={d} value={draft.preferredModel ?? ""} onChange={(e) => set("preferredModel", e.target.value || null)} disabled={!canEdit} placeholder="Ex.: opus" />}
          </Field>
        </div>
        {editLock && <LockedNote>{editLock}</LockedNote>}
      </Card>

      {pauseCard}

      <InlineError message={error} />

      {saveBar}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Apagar ${agent.name}?`}
        body="As instruções, a memória individual e as configurações somem. Mensagens antigas continuam nas conversas."
        confirmLabel="Apagar agente"
        danger
        loading={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

const PREPARE_PRESETS: { cron: string; label: string }[] = [
  { cron: "0 8-18/2 * * 1-5", label: "A cada 2 horas, dias úteis (8h–18h)" },
  { cron: "0 8 * * 1-5", label: "Uma vez por dia às 8h" },
  { cron: "0 8-18 * * 1-5", label: "A cada hora, dias úteis" },
];

function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Preparação automática: o agente olha as fontes sozinho, rascunha e só avisa quando há algo concreto. */
function ProactiveCard({ agent }: { agent: AgentDTO }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const members = useWorkspace((s) => s.members);
  /** undefined = carregando; null = desligada. */
  const [routine, setRoutine] = useState<RoutineDTO | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setRoutine(undefined);
    setLoadError(null);
    api
      .listRoutines(ws, { agentId: agent.id })
      .then((l) => alive && setRoutine(l.find((r) => r.kind === "prepare" && r.enabled) ?? null))
      .catch((e) => alive && setLoadError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [ws, agent.id]);

  const on = !!routine;
  const isOwner = agent.ownerUserId === me?.userId;
  /** Só o responsável liga; um admin pode desligar. */
  const canToggle = isOwner || (on && isAdmin(me?.role));
  const ownerName = members[agent.ownerUserId]?.name ?? "outra pessoa";

  const apply = async (input: { enabled: boolean; cron?: string; timezone?: string }) => {
    setBusy(true);
    setError(null);
    try {
      setRoutine(await api.setProactive(ws, agent.id, input));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const known = routine ? PREPARE_PRESETS.some((p) => p.cron === routine.cron) : true;

  return (
    <Card>
      <Heading
        title="Preparação automática"
        text="O agente olha sozinho as fontes conectadas, prepara rascunhos e só manda mensagem ao responsável quando há algo concreto em aberto. Neste modo ele nunca muda nada em um serviço conectado: só lê e rascunha. Os rascunhos ficam na pasta “Rascunhos” do Drive."
      />
      {loadError ? (
        <InlineError message={loadError} />
      ) : routine === undefined ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <>
          <Toggle
            label="Preparar sozinho"
            description={on ? "Ligada." : "Desligada: o agente só trabalha quando alguém pede ou em uma rotina."}
            checked={on}
            onChange={(v) => void apply(v ? { enabled: true, cron: PREPARE_PRESETS[0]!.cron, timezone: browserTimezone() } : { enabled: false })}
            disabled={!canToggle || busy}
            disabledReason={canToggle ? undefined : `Só o responsável (${ownerName}) liga a preparação automática.`}
          />
          {on && !isOwner && canToggle && <LockedNote>Como admin, você pode desligar. Só o responsável liga de novo e muda o horário.</LockedNote>}
          {routine && (
            <div className="mt-3 border-t border-line pt-3">
              <Field label="Quando o agente olha" hint={`Horário de ${routine.timezone}.${routine.nextRunAt ? ` Próxima vez: ${formatDateTime(routine.nextRunAt)}.` : ""}`}>
                {(id, d) => (
                  <Select id={id} aria-describedby={d} value={routine.cron} onChange={(e) => void apply({ enabled: true, cron: e.target.value, timezone: routine.timezone })} disabled={!isOwner || busy}>
                    {!known && <option value={routine.cron}>{describeCron(routine.cron)}</option>}
                    {PREPARE_PRESETS.map((p) => (
                      <option key={p.cron} value={p.cron}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
        </>
      )}
      <div className="mt-2">
        <InlineError message={error} />
      </div>
    </Card>
  );
}

function Heading({ title, text }: { title: string; text?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {text && <p className="text-xs text-muted">{text}</p>}
    </div>
  );
}

function CheckList({ children }: { children: ReactNode }) {
  return <ul className="grid gap-1 sm:grid-cols-2">{children}</ul>;
}

function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <li>
      <label className={cn("flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-surface-2 max-md:min-h-11", disabled && "cursor-default opacity-70")}>
        <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="size-4 accent-[var(--tb-primary)]" />
        {children}
      </label>
    </li>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  disabled,
  min = 0,
  max,
  step = 1,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id, d) => (
        <Input
          id={id}
          aria-describedby={d}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(null);
            const n = Number(raw);
            if (Number.isFinite(n)) onChange(Math.round(n));
          }}
        />
      )}
    </Field>
  );
}

