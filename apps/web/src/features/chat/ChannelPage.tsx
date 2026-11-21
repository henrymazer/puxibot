import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Hash, Lock, MoreVertical, Pin, Trash2, UserRound, Users } from "lucide-react";
import type { ChannelDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { errorMessage } from "../../api";
import { api } from "../../api";
import { firstUnreadId } from "../../lib/timeline";
import { ACTIVITY_LABEL, channelLabel, dmPeer, isAdmin } from "../../lib/actors";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { ConfirmDialog, EmptyState, ErrorState, IconButton, LoadingState } from "../../components/ui";
import { MenuItem, Popover } from "../../components/Popover";
import { toast } from "../../components/toast";
import { PageHeader } from "../shell/PageHeader";
import { useAgentProfile, useWsId } from "../shell/hooks";
import { MessageList } from "./MessageList";
import { Composer, composerKey } from "./Composer";
import { PendingJobs, usePendingJobs } from "./PendingJobs";
import { ThreadPanel } from "./ThreadPanel";
import { MembersPanel } from "./MembersPanel";
import { PinnedPanel } from "./PinnedPanel";

type Panel = "members" | "pins" | null;

export function ChannelPage() {
  const ws = useWsId();
  const { channelId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread");
  const highlight = params.get("msg");
  const channel = useWorkspace((s) => s.channels[channelId]);
  const list = useWorkspace((s) => s.messages[channelId]);
  const myUserId = useWorkspace((s) => s.myUserId);
  const { setActiveChannel, loadChannel, loadOlder, loadChannelJobs } = useWorkspace.getState();
  const [error, setError] = useState<string | null>(null);
  const [marker, setMarker] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const exists = !!channel;
  const unreadRef = useRef<{ id: string; n: number } | null>(null);

  useEffect(() => {
    if (!exists) return;
    // Guardado uma vez por canal: abrir o canal zera o contador (e o StrictMode roda o efeito duas vezes).
    if (unreadRef.current?.id !== channelId) {
      unreadRef.current = { id: channelId, n: useWorkspace.getState().channels[channelId]?.unread ?? 0 };
    }
    const unreadAtOpen = unreadRef.current.n;
    setMarker(null);
    setError(null);
    setPanel(null);
    setActiveChannel(channelId);
    try {
      localStorage.setItem(`tb-last-channel:${ws}`, channelId);
    } catch {
      /* ignore */
    }
    let alive = true;
    const load = async () => {
      try {
        await loadChannel(channelId);
        if (!alive) return;
        const items = useWorkspace.getState().messages[channelId]?.items ?? [];
        setMarker(firstUnreadId(items, unreadAtOpen, useWorkspace.getState().myUserId));
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    };
    void load();
    void loadChannelJobs(channelId);
    return () => {
      alive = false;
      useWorkspace.getState().setActiveChannel(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, exists, ws]);

  const pending = usePendingJobs(channelId, null);
  const footerKey = pending.map((p) => `${p.jobId}:${p.job?.status}:${p.stream?.text.length ?? 0}`).join("|");

  if (!channel) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Conversa" />
        <EmptyState title="Conversa não encontrada" className="mt-16">
          Ela pode ter sido apagada, ou você não faz parte dela.
        </EmptyState>
      </div>
    );
  }

  const openThread = (rootId: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("thread", rootId);
      return n;
    });
  const closeThread = () =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("thread");
      return n;
    });

  const sidePanel = threadId ? "thread" : panel;
  const label = channelLabel({ members: useWorkspace.getState().members, agents: useWorkspace.getState().agents, myUserId }, channel);

  return (
    <div className="flex h-full min-w-0 flex-1">
      <section className={cn("flex min-w-0 flex-1 flex-col bg-bg", sidePanel && "max-lg:hidden")} aria-label={`Conversa ${label}`}>
        <ChannelHeader
          channel={channel}
          panel={panel}
          onPanel={(p) => {
            if (threadId) closeThread();
            setPanel((cur) => (cur === p ? null : p));
          }}
        />
        {error ? (
          <ErrorState message={error} onRetry={() => void loadChannel(channelId, true).then(() => setError(null)).catch((e) => setError(errorMessage(e)))} />
        ) : !list?.loaded ? (
          <LoadingState label="Carregando mensagens…" className="flex-1" />
        ) : (
          <MessageList
            scrollKey={channelId}
            messages={list.items}
            hasMore={list.hasMore}
            onLoadOlder={() => loadOlder(channelId)}
            firstUnreadId={marker}
            composerKey={composerKey(channelId)}
            onOpenThread={openThread}
            header={<ChannelIntro channel={channel} label={label} />}
            footer={<PendingJobs items={pending} />}
            footerKey={footerKey}
            highlightId={highlight}
          />
        )}
        <Composer
          channel={channel}
          autoFocus
          placeholder={channel.kind === "dm" ? `Mensagem para ${label}` : `Mensagem em #${channel.name}`}
        />
      </section>
      {sidePanel && (
        <aside
          className="flex min-w-0 flex-col border-l border-line bg-surface max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:border-0 lg:w-[var(--tb-panel-w)] lg:shrink-0"
          aria-label={sidePanel === "thread" ? "Thread" : sidePanel === "members" ? "Membros" : "Mensagens fixadas"}
        >
          {sidePanel === "thread" && threadId && <ThreadPanel channel={channel} rootId={threadId} onClose={closeThread} />}
          {sidePanel === "members" && <MembersPanel channel={channel} onClose={() => setPanel(null)} />}
          {sidePanel === "pins" && (
            <PinnedPanel
              channel={channel}
              onClose={() => setPanel(null)}
              onJump={(m) => {
                setPanel(null);
                if (m.threadRootId) openThread(m.threadRootId);
                else
                  setParams((p) => {
                    const n = new URLSearchParams(p);
                    n.set("msg", m.id);
                    return n;
                  });
              }}
            />
          )}
        </aside>
      )}
    </div>
  );
}

function ChannelHeader({ channel, panel, onPanel }: { channel: ChannelDTO; panel: Panel; onPanel: (p: Exclude<Panel, null>) => void }) {
  const ws = useWsId();
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  const me = useWorkspace((s) => s.me);
  const { open: openAgent } = useAgentProfile();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "leave" | null>(null);
  const [busy, setBusy] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const label = channelLabel({ members, agents, myUserId }, channel);

  let icon: React.ReactNode;
  let subtitle: React.ReactNode = channel.topic;
  if (channel.kind === "dm") {
    const peer = dmPeer(channel, myUserId);
    const agent = peer?.type === "agent" ? agents[peer.id] : undefined;
    const member = peer?.type === "user" ? members[peer.id] : undefined;
    icon = agent ? <AgentAvatar agent={agent} size="sm" showActivity /> : <PersonAvatar member={member} size="sm" presence={member?.online ?? false} />;
    subtitle = agent
      ? `${agent.role ?? "Agente"} · ${agent.status === "paused" ? "Pausado" : ACTIVITY_LABEL[agent.activity]}`
      : member
        ? [member.online ? "Online" : "Offline", member.statusText, member.title].filter(Boolean).join(" · ")
        : null;
    if (agent) {
      const a = agent;
      icon = (
        <button type="button" onClick={() => openAgent(a.id)} aria-label={`Perfil de ${a.name}`}>
          {icon}
        </button>
      );
    }
  } else {
    icon = channel.isPrivate ? <Lock className="size-4.5" aria-label="Canal privado" /> : <Hash className="size-4.5" aria-hidden />;
    if (channel.humansOnly) subtitle = <span className="inline-flex items-center gap-1"><UserRound className="size-3" aria-hidden /> Só pessoas{channel.topic ? ` · ${channel.topic}` : ""}</span>;
  }

  const doConfirm = async () => {
    setBusy(true);
    try {
      if (confirm === "delete") await api.deleteChannel(ws, channel.id);
      else if (confirm === "leave" && myUserId) await api.removeChannelMember(ws, channel.id, { type: "user", id: myUserId });
      useWorkspace.getState().dispatch({ type: "channel.deleted", channelId: channel.id });
      navigate(paths.workspace(ws));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <>
      <PageHeader
        title={channel.kind === "dm" ? label : channel.name}
        icon={icon}
        subtitle={subtitle}
        actions={
          <>
            <IconButton label="Mensagens fixadas" active={panel === "pins"} onClick={() => onPanel("pins")}>
              <Pin className="size-4.5" />
            </IconButton>
            <button
              type="button"
              onClick={() => onPanel("members")}
              aria-pressed={panel === "members"}
              aria-label={`Membros (${channel.members.length})`}
              className={cn(
                "inline-flex h-10 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted hover:bg-surface-2 hover:text-ink",
                panel === "members" && "bg-surface-2 text-ink",
              )}
            >
              <Users className="size-4.5" aria-hidden />
              <span className="tabular-nums">{channel.members.length}</span>
            </button>
            {channel.kind === "channel" && (
              <IconButton ref={menuAnchor} label="Mais opções do canal" onClick={() => setMenu((v) => !v)}>
                <MoreVertical className="size-4.5" />
              </IconButton>
            )}
          </>
        }
      />
      <Popover open={menu} onClose={() => setMenu(false)} anchor={menuAnchor} align="end" label="Opções do canal" className="w-60 py-1">
        <div role="menu">
          <MenuItem
            icon={<Users className="size-4" />}
            onClick={() => {
              setMenu(false);
              onPanel("members");
            }}
          >
            Adicionar pessoas ou agentes
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(false);
              setConfirm("leave");
            }}
          >
            Sair do canal
          </MenuItem>
          {isAdmin(me?.role) && (
            <MenuItem
              danger
              icon={<Trash2 className="size-4" />}
              onClick={() => {
                setMenu(false);
                setConfirm("delete");
              }}
            >
              Apagar canal
            </MenuItem>
          )}
        </div>
      </Popover>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => void doConfirm()}
        loading={busy}
        danger={confirm === "delete"}
        title={confirm === "delete" ? `Apagar #${channel.name}?` : `Sair de #${channel.name}?`}
        body={confirm === "delete" ? "As mensagens do canal somem para todo mundo. Não dá para desfazer." : channel.isPrivate ? "Para voltar, alguém do canal precisa adicionar você." : "Você pode voltar quando quiser."}
        confirmLabel={confirm === "delete" ? "Apagar canal" : "Sair"}
      />
    </>
  );
}

function ChannelIntro({ channel, label }: { channel: ChannelDTO; label: string }) {
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  const peer = channel.kind === "dm" ? dmPeer(channel, myUserId) : null;
  const agent = peer?.type === "agent" ? agents[peer.id] : undefined;
  return (
    <div className="px-3 pt-10 pb-4 md:px-5">
      {agent ? (
        <>
          <AgentAvatar agent={agent} size="xl" />
          <h2 className="mt-3 text-xl font-semibold">{agent.name}</h2>
          <p className="mt-1 max-w-prose text-sm text-muted">
            {agent.description ?? "Agente do time."} Escreva aqui e {agent.name} responde.{" "}
            {agent.ownerUserId === myUserId
              ? "A resposta roda no seu computador; deixe o runner ligado."
              : `Esta conversa é só sua, então a resposta roda no seu computador (o de quem responde por ${agent.name} não enxerga esta DM). Sem o seu runner ligado, o pedido espera.`}
          </p>
        </>
      ) : (
        <>
          <h2 className="text-xl font-semibold">{channel.kind === "dm" ? `Conversa com ${label}` : `Este é o começo de #${label}`}</h2>
          <p className="mt-1 max-w-prose text-sm text-muted">
            {channel.topic ?? (channel.humansOnly ? "Canal só de pessoas: agentes não leem nem respondem aqui." : "Mencione um agente com @ para pedir ajuda.")}
          </p>
        </>
      )}
    </div>
  );
}
