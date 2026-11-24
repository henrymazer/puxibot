import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Layers, MessageSquare, Network, Plus, UserPlus, Users, Wand2 } from "lucide-react";
import type { AgentDTO, MemberDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { ACTIVITY_LABEL, isAdmin, ROLE_LABEL } from "../../lib/actors";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Badge, Button, EmptyState, IconButton, Tabs } from "../../components/ui";
import { toast } from "../../components/toast";
import { PageHeader } from "../shell/PageHeader";
import { useAgentProfile, useWsId } from "../shell/hooks";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { InviteDialog, MemberDialog, SectorsDialog } from "./TeamDialogs";
import { GovernanceView } from "./GovernanceView";

type View = "lista" | "organograma" | "governanca";
type OrgMode = "pessoa" | "setor";

export function TeamPage() {
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const me = useWorkspace((s) => s.me);
  const navigate = useNavigate();
  const ws = useWsId();
  const [view, setView] = useState<View>(() => {
    try {
      const v = sessionStorage.getItem("tb-team-view");
      return v === "organograma" || v === "governanca" ? v : "lista";
    } catch {
      return "lista";
    }
  });
  const [orgMode, setOrgMode] = useState<OrgMode>("pessoa");
  const [dialog, setDialog] = useState<"agent" | "invite" | "sectors" | null>(null);
  const [editMember, setEditMember] = useState<MemberDTO | null>(null);
  const admin = isAdmin(me?.role);

  const changeView = (v: View) => {
    setView(v);
    try {
      sessionStorage.setItem("tb-team-view", v);
    } catch {
      /* ignore */
    }
  };

  // Quem não é admin não vê a aba de governança, mesmo se ela ficou salva.
  const current: View = view === "governanca" && !admin ? "lista" : view;
  // O agente criador de cada pessoa é só dela (e aparece na tela "Montar com o criador").
  const agentList = useMemo(
    () => Object.values(agents).filter((a) => a.systemKind !== "builder").sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [agents],
  );
  const memberList = useMemo(() => Object.values(members).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")), [members]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title="Equipe"
        icon={<Users className="size-5" />}
        subtitle={`${memberList.length} ${memberList.length === 1 ? "pessoa" : "pessoas"} · ${agentList.length} ${agentList.length === 1 ? "agente" : "agentes"}`}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<Layers className="size-4" />} onClick={() => setDialog("sectors")} className="max-sm:hidden">
              Setores
            </Button>
            <IconButton label="Setores" onClick={() => setDialog("sectors")} className="sm:hidden">
              <Layers className="size-4" />
            </IconButton>
            <Button variant="secondary" size="sm" icon={<UserPlus className="size-4" />} onClick={() => setDialog("invite")} disabled={!admin} title={admin ? undefined : "Só admins convidam pessoas"} className="max-sm:hidden">
              Convidar
            </Button>
            <IconButton label="Convidar pessoas" onClick={() => setDialog("invite")} disabled={!admin} className="sm:hidden">
              <UserPlus className="size-4" />
            </IconButton>
            <Button variant="secondary" size="sm" icon={<Wand2 className="size-4" />} onClick={() => navigate(paths.setup(ws))} className="max-sm:hidden" title="Conte como você trabalha e o criador propõe agentes, canais e rotinas">
              Montar com o criador
            </Button>
            <IconButton label="Montar com o criador" onClick={() => navigate(paths.setup(ws))} className="sm:hidden">
              <Wand2 className="size-4" />
            </IconButton>
            <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setDialog("agent")}>
              <span className="max-sm:hidden">Criar agente</span>
              <span className="sm:hidden">Agente</span>
            </Button>
          </>
        }
      />
      <div className="border-b border-line bg-surface px-3 md:px-5">
        <Tabs
          label="Visão da equipe"
          value={current}
          onChange={changeView}
          tabs={[
            { id: "lista", label: "Lista" },
            { id: "organograma", label: "Organograma" },
            ...(admin ? [{ id: "governanca" as const, label: "Governança e uso" }] : []),
          ]}
          className="border-b-0"
        />
      </div>
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full p-3 md:p-6", current === "governanca" ? "max-w-6xl" : "max-w-5xl")}>
          {current === "governanca" ? (
            <GovernanceView agents={agentList} />
          ) : current === "lista" ? (
            <ListView agents={agentList} members={memberList} onEditMember={setEditMember} onCreateAgent={() => setDialog("agent")} />
          ) : (
            <OrgView mode={orgMode} onMode={setOrgMode} agents={agentList} members={memberList} />
          )}
        </div>
      </div>
      {dialog === "agent" && <CreateAgentDialog onClose={() => setDialog(null)} />}
      {dialog === "invite" && <InviteDialog onClose={() => setDialog(null)} />}
      {dialog === "sectors" && <SectorsDialog onClose={() => setDialog(null)} />}
      {editMember && <MemberDialog member={editMember} onClose={() => setEditMember(null)} />}
    </div>
  );
}

function useStartDm() {
  const ws = useWsId();
  const openDm = useWorkspace((s) => s.openDm);
  const navigate = useNavigate();
  return (type: "user" | "agent", id: string) =>
    openDm({ type, id })
      .then((ch) => navigate(paths.channel(ws, ch.id)))
      .catch(toast.error);
}

function activityTone(a: AgentDTO): "neutral" | "agent" | "warning" | "danger" {
  if (a.status === "paused") return "neutral";
  if (a.activity === "working") return "agent";
  if (a.activity === "waiting_approval" || a.activity === "queued_no_runner") return "warning";
  if (a.activity === "error") return "danger";
  return "neutral";
}

export function AgentStatusBadge({ agent }: { agent: AgentDTO }) {
  return (
    <Badge tone={activityTone(agent)}>
      {agent.activity === "working" && agent.status !== "paused" && <span className="tb-dot-pulse size-1.5 rounded-full bg-agent" aria-hidden />}
      {agent.status === "paused" ? "Pausado" : ACTIVITY_LABEL[agent.activity]}
    </Badge>
  );
}

function ListView({
  agents,
  members,
  onEditMember,
  onCreateAgent,
}: {
  agents: AgentDTO[];
  members: MemberDTO[];
  onEditMember: (m: MemberDTO) => void;
  onCreateAgent: () => void;
}) {
  const sectors = useWorkspace((s) => s.sectors);
  const allMembers = useWorkspace((s) => s.members);
  const me = useWorkspace((s) => s.me);
  const profile = useAgentProfile();
  const startDm = useStartDm();
  const admin = isAdmin(me?.role);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="team-agents">
        <h2 id="team-agents" className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted">
          <Bot className="size-4" aria-hidden /> Agentes
        </h2>
        {agents.length === 0 ? (
          <EmptyState icon={<Bot className="size-5" />} title="Nenhum agente ainda" action={<Button variant="primary" onClick={onCreateAgent}>Criar agente</Button>}>
            Agentes respondem no chat quando alguém os chama com @.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {agents.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2.5 md:px-4">
                <button type="button" onClick={() => profile.open(a.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left">
                  <AgentAvatar agent={a} size="md" showActivity />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-sm font-semibold">{a.name}</span>
                      <span className="text-xs text-subtle">@{a.handle}</span>
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {[a.role, a.sectorId ? sectors[a.sectorId]?.name : null].filter(Boolean).join(" · ") || "Sem função definida"}
                    </span>
                  </span>
                </button>
                <span className="hidden min-w-0 text-xs text-muted md:block md:w-44 md:truncate">
                  Responsável: {allMembers[a.ownerUserId]?.name ?? "—"}
                </span>
                <span className="max-sm:hidden">
                  <AgentStatusBadge agent={a} />
                </span>
                <IconButton label={`Conversar com ${a.name}`} onClick={() => void startDm("agent", a.id)}>
                  <MessageSquare className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="team-people">
        <h2 id="team-people" className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted">
          <Users className="size-4" aria-hidden /> Pessoas
        </h2>
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-3 py-2.5 md:px-4">
              <button
                type="button"
                onClick={() => onEditMember(m)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left"
                aria-label={`${m.name}${admin ? ", editar papel e cargo" : ", ver detalhes"}`}
              >
                <PersonAvatar member={m} size="md" presence={m.online} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="truncate text-sm font-semibold">{m.name}</span>
                    {m.userId === me?.userId && <span className="text-xs text-subtle">(você)</span>}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {[m.title, m.statusText ? `“${m.statusText}”` : null].filter(Boolean).join(" · ") || m.email}
                  </span>
                </span>
              </button>
              <span className="hidden text-xs text-muted md:block md:w-44">
                {m.online ? "Online" : "Offline"} · {m.runnerOnline ? "computador ligado" : "sem computador"}
              </span>
              <Badge tone={m.role === "member" ? "neutral" : "primary"}>{ROLE_LABEL[m.role]}</Badge>
              {m.userId !== me?.userId && (
                <IconButton label={`Conversar com ${m.name}`} onClick={() => void startDm("user", m.userId)}>
                  <MessageSquare className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function OrgView({ mode, onMode, agents, members }: { mode: OrgMode; onMode: (m: OrgMode) => void; agents: AgentDTO[]; members: MemberDTO[] }) {
  const sectors = useWorkspace((s) => s.sectors);
  const allMembers = useWorkspace((s) => s.members);
  const workspace = useWorkspace((s) => s.workspace);

  const groups = useMemo(() => {
    if (mode === "pessoa") {
      return members
        .map((m) => ({
          key: m.userId,
          head: <PersonNode member={m} />,
          people: [] as MemberDTO[],
          agents: agents.filter((a) => a.ownerUserId === m.userId),
        }))
        .sort((a, b) => b.agents.length - a.agents.length);
    }
    const list = Object.values(sectors)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((s) => ({
        key: s.id,
        head: <SectorNode name={s.name} lead={s.leadUserId ? allMembers[s.leadUserId] : undefined} />,
        people: members.filter((m) => m.sectorId === s.id),
        agents: agents.filter((a) => a.sectorId === s.id),
      }));
    const loose = agents.filter((a) => !a.sectorId || !sectors[a.sectorId]);
    const loosePeople = members.filter((m) => !m.sectorId || !sectors[m.sectorId]);
    if (loose.length || loosePeople.length) list.push({ key: "none", head: <SectorNode name="Sem setor" />, people: loosePeople, agents: loose });
    return list;
  }, [mode, members, agents, sectors, allMembers]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted" id="org-mode">
          Agrupar por
        </span>
        <div role="radiogroup" aria-labelledby="org-mode" className="inline-flex rounded-md border border-line bg-surface p-0.5">
          {(
            [
              ["pessoa", "Pessoa responsável"],
              ["setor", "Setor"],
            ] as [OrgMode, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              onClick={() => onMode(id)}
              className={cn("h-8 rounded-sm px-3 text-sm max-md:h-10", mode === id ? "bg-primary-soft font-medium text-primary-text" : "text-muted hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-center">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2">
          <Network className="size-4 text-primary" aria-hidden />
          <span className="text-sm font-semibold">{workspace?.name}</span>
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={<Layers className="size-5" />} title="Nenhum setor criado">
          Crie setores no botão “Setores” para ver o organograma por área.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <li key={g.key} className="rounded-lg border border-line bg-surface p-3">
              {g.head}
              {g.people.length > 0 && (
                <ul className="mt-2 ml-5 border-l border-line" aria-label="Pessoas do setor">
                  {g.people.map((m) => (
                    <li key={m.userId} className="relative pl-4 before:absolute before:top-1/2 before:left-0 before:w-3 before:border-t before:border-line">
                      <div className="my-0.5 flex items-center gap-2 px-1.5 py-1.5 max-md:min-h-11">
                        <PersonAvatar member={m} size="sm" presence={m.online} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{m.name}</span>
                          <span className="block truncate text-xs text-muted">{m.title || ROLE_LABEL[m.role]}</span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {g.agents.length === 0 ? (
                <p className="mt-2 ml-5 border-l border-line pl-4 text-xs text-subtle">{mode === "setor" && g.people.length === 0 ? "Ninguém neste setor ainda" : "Nenhum agente"}</p>
              ) : (
                <ul className="mt-2 ml-5 border-l border-line">
                  {g.agents.map((a) => (
                    <li key={a.id} className="relative pl-4 before:absolute before:top-1/2 before:left-0 before:w-3 before:border-t before:border-line">
                      <AgentNode agent={a} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonNode({ member }: { member: MemberDTO }) {
  return (
    <div className="flex items-center gap-2.5">
      <PersonAvatar member={member} size="md" presence={member.online} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{member.name}</div>
        <div className="truncate text-xs text-muted">{member.title || ROLE_LABEL[member.role]}</div>
      </div>
    </div>
  );
}

function SectorNode({ name, lead }: { name: string; lead?: MemberDTO }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
        <Layers className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{name}</div>
        <div className="truncate text-xs text-muted">{lead ? `Líder: ${lead.name}` : "Sem líder"}</div>
      </div>
    </div>
  );
}

function AgentNode({ agent }: { agent: AgentDTO }) {
  const profile = useAgentProfile();
  return (
    <button type="button" onClick={() => profile.open(agent.id)} className="my-0.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-surface-2 max-md:min-h-11">
      <AgentAvatar agent={agent} size="sm" showActivity />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{agent.name}</span>
        <span className="block truncate text-xs text-muted">{agent.role ?? `@${agent.handle}`}</span>
      </span>
      {agent.status === "paused" && <Badge>Pausado</Badge>}
    </button>
  );
}
