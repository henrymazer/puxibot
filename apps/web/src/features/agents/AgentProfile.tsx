import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, MessageSquare } from "lucide-react";
import type { AgentDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { ACTIVITY_LABEL, CLI_LABEL, canEditAgent, isAdmin, isOthersAssistant } from "../../lib/actors";
import { paths } from "../../lib/paths";
import { formatDateTime, formatNumber } from "../../lib/format";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Badge, Button, Card, EmptyState, InlineError, LockedNote, Modal, Tabs, Textarea } from "../../components/ui";
import { toast } from "../../components/toast";
import { useAgentProfile, useWsId } from "../shell/hooks";
import { budgetPercent, UsageBar, useAgentUsage, useSaveAgent } from "./shared";
import { MemoryTab } from "./MemoryTab";
import { ActivityTab } from "./ActivityTab";
import { GovernanceTab } from "./GovernanceTab";
import { ToolsTab } from "./ToolsTab";
import { RoutineList } from "../routines/RoutineList";

type TabId = "geral" | "instrucoes" | "memoria" | "atividade" | "rotinas" | "configuracoes" | "ferramentas";
const TABS: { id: TabId; label: string }[] = [
  { id: "geral", label: "Visão geral" },
  { id: "instrucoes", label: "Instruções" },
  { id: "memoria", label: "Memória" },
  { id: "atividade", label: "Atividade" },
  { id: "rotinas", label: "Rotinas" },
  { id: "configuracoes", label: "Configurações" },
  { id: "ferramentas", label: "Ferramentas e acesso" },
];

/** Montado pelo AppShell: abre o perfil quando a URL tem `?agente=<id>`. */
export function AgentProfileHost() {
  const { agentId, tab, close, setTab } = useAgentProfile();
  const agent = useWorkspace((s) => (agentId ? s.agents[agentId] : undefined));
  if (!agentId) return null;
  const current: TabId = TABS.some((t) => t.id === tab) ? (tab as TabId) : "geral";
  if (!agent) {
    return (
      <Modal open onClose={close} title="Agente" size="sm">
        <EmptyState icon={<Bot className="size-5" />} title="Agente não encontrado">
          Ele pode ter sido apagado, ou você não tem acesso.
        </EmptyState>
      </Modal>
    );
  }
  return <AgentProfileModal key={agent.id} agent={agent} tab={current} onTab={setTab} onClose={close} />;
}

/** No assistente pessoal de outra pessoa só aparecem a visão geral e pausa/orçamento. */
const OTHERS_ASSISTANT_TABS: TabId[] = ["geral", "configuracoes"];

function AgentProfileModal({ agent, tab: requested, onTab, onClose }: { agent: AgentDTO; tab: TabId; onTab: (t: string) => void; onClose: () => void }) {
  const me = useWorkspace((s) => s.me);
  const restricted = isOthersAssistant(agent, me);
  const tabs = restricted ? TABS.filter((t) => OTHERS_ASSISTANT_TABS.includes(t.id)) : TABS;
  const tab: TabId = tabs.some((t) => t.id === requested) ? requested : "geral";
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={agent.name}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>@{agent.handle}</span>
          {agent.role && <span>· {agent.role}</span>}
          {agent.isAssistant && <Badge tone="agent">Assistente pessoal</Badge>}
          {agent.status === "paused" && <Badge>Pausado</Badge>}
        </span>
      }
      className="md:h-[min(88vh,820px)]"
    >
      <div className="-mx-5 -mt-4 mb-4 bg-elevated px-3 md:px-5">
        <Tabs label="Seções do perfil" tabs={tabs} value={tab} onChange={(t) => onTab(t)} />
      </div>
      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)?.label}>
        {tab === "geral" && <OverviewTab agent={agent} />}
        {tab === "instrucoes" && <InstructionsTab agent={agent} />}
        {tab === "memoria" && <MemoryTab agent={agent} />}
        {tab === "atividade" && <ActivityTab agent={agent} />}
        {tab === "rotinas" && <RoutineList agentId={agent.id} />}
        {tab === "configuracoes" && <GovernanceTab agent={agent} onDeleted={onClose} />}
        {tab === "ferramentas" && <ToolsTab agent={agent} />}
      </div>
    </Modal>
  );
}

function OverviewTab({ agent }: { agent: AgentDTO }) {
  const ws = useWsId();
  const members = useWorkspace((s) => s.members);
  const sectors = useWorkspace((s) => s.sectors);
  const me = useWorkspace((s) => s.me);
  const openDm = useWorkspace((s) => s.openDm);
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const owner = members[agent.ownerUserId];
  const seesBudget = isAdmin(me?.role) || agent.ownerUserId === me?.userId;
  const { usage, error, loading } = useAgentUsage(ws, agent.id, seesBudget);
  const pct = budgetPercent(agent, usage);
  const canTalk =
    agent.accessMode === "workspace" ||
    agent.ownerUserId === me?.userId ||
    (agent.accessMode === "restricted" && !!me && agent.allowedUserIds.includes(me.userId));

  const talk = () => {
    setOpening(true);
    openDm({ type: "agent", id: agent.id })
      .then((ch) => navigate(paths.channel(ws, ch.id)))
      .catch(toast.error)
      .finally(() => setOpening(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <AgentAvatar agent={agent} size="xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">{agent.description || "Sem descrição ainda."}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge tone={agent.status === "paused" ? "neutral" : agent.activity === "working" ? "agent" : agent.activity === "error" ? "danger" : agent.activity === "idle" ? "success" : "warning"}>
              {agent.status === "paused" ? "Pausado" : ACTIVITY_LABEL[agent.activity]}
            </Badge>
            {agent.preferredCli && <Badge>{CLI_LABEL[agent.preferredCli]}{agent.preferredModel ? ` · ${agent.preferredModel}` : ""}</Badge>}
          </div>
        </div>
        <div className="flex flex-col items-start gap-1">
          <Button variant="primary" icon={<MessageSquare className="size-4" />} onClick={talk} loading={opening} disabled={!canTalk}>
            Conversar
          </Button>
          {!canTalk && (
            <LockedNote>
              {agent.isAssistant ? "Assistente pessoal: só conversa com a pessoa dona dele." : agent.accessMode === "owner" ? "Só conversa com o responsável." : "Você não está na lista de quem pode falar."}
            </LockedNote>
          )}
        </div>
      </div>

      {canTalk && agent.ownerUserId !== me?.userId && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          Numa conversa direta sua com {agent.name}, quem executa é o <strong className="font-medium text-ink">seu</strong> computador: o Puxibot não usa o computador de{" "}
          {owner?.name ?? "outra pessoa"}, que não enxerga a sua DM. Deixe o seu computador ligado com o runner (Configurações › Computadores); sem ele, o pedido
          espera. Em canais, o pedido vai para o seu computador ou, se ele estiver desligado, para o de {owner?.name ?? "quem responde pelo agente"}.
        </p>
      )}

      <dl className="grid gap-3 sm:grid-cols-3">
        <Card className="p-3 md:p-3">
          <dt className="text-xs text-muted">Responsável</dt>
          <dd className="mt-1 flex items-center gap-2 text-sm font-medium">
            <PersonAvatar member={owner} name="?" size="xs" />
            {owner?.name ?? "Pessoa removida"}
          </dd>
        </Card>
        <Card className="p-3 md:p-3">
          <dt className="text-xs text-muted">Setor</dt>
          <dd className="mt-1 text-sm font-medium">{(agent.sectorId && sectors[agent.sectorId]?.name) || "Sem setor"}</dd>
        </Card>
        <Card className="p-3 md:p-3">
          <dt className="text-xs text-muted">Quem pode falar</dt>
          <dd className="mt-1 text-sm font-medium">
            {agent.accessMode === "workspace" ? "Todo o workspace" : agent.accessMode === "owner" ? "Só o responsável" : `${agent.allowedUserIds.length} pessoas escolhidas`}
          </dd>
        </Card>
      </dl>

      <Card>
        <h3 className="mb-3 text-sm font-semibold">Uso neste mês</h3>
        {!seesBudget ? (
          <LockedNote>Só admins e o responsável veem o uso e o orçamento.</LockedNote>
        ) : loading ? (
          <p className="text-sm text-muted">Carregando…</p>
        ) : error ? (
          <InlineError message={error} />
        ) : usage ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Execuções" value={formatNumber(usage.runs)} />
              <Stat label="Tokens" value={formatNumber(usage.inputTokens + usage.outputTokens)} />
              <Stat label="Criado em" value={formatDateTime(agent.createdAt)} />
            </div>
            {pct !== null && <UsageBar percent={pct} label="Orçamento do mês" />}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function InstructionsTab({ agent }: { agent: AgentDTO }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const canEdit = canEditAgent(agent, me);
  const [draft, setDraft] = useState(agent.instructions);
  const { save, saving, error } = useSaveAgent(ws, agent);
  const dirty = draft !== agent.instructions;

  // Se outra pessoa salvar enquanto não há edição local, acompanha.
  useEffect(() => {
    if (!dirty) setDraft(agent.instructions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.instructions]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        O que o agente deve saber e como deve se comportar. Vale para qualquer computador e qualquer CLI que executar o agente.
      </p>
      <label htmlFor="agent-instructions" className="sr-only">
        Instruções
      </label>
      <Textarea
        id="agent-instructions"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={!canEdit}
        className="min-h-[45vh] font-mono text-sm leading-relaxed"
        placeholder="Ex.: Você é o Tito, engenheiro do time. Responda de forma curta…"
        maxLength={50_000}
      />
      {!canEdit && <LockedNote>Só o responsável ou um admin muda as instruções.</LockedNote>}
      <InlineError message={error} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && <span className="mr-auto text-xs text-warning">Alterações não salvas</span>}
        <span className="text-xs text-subtle">{formatNumber(draft.length)} caracteres</span>
        <Button disabled={!dirty || saving} onClick={() => setDraft(agent.instructions)}>
          Descartar
        </Button>
        <Button variant="primary" disabled={!dirty || !canEdit} loading={saving} onClick={() => void save({ instructions: draft }, "Instruções salvas.")}>
          Salvar instruções
        </Button>
      </div>
    </div>
  );
}
