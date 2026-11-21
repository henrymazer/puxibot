import { useState } from "react";
import { MessageSquare, UserMinus, UserPlus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ActorRef, ChannelDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { api } from "../../api";
import { toast } from "../../components/toast";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Button, IconButton } from "../../components/ui";
import { ACTIVITY_LABEL } from "../../lib/actors";
import { paths } from "../../lib/paths";
import { useAgentProfile } from "../shell/hooks";
import { ActorPicker, toggleIn } from "./ActorPicker";
import { PanelHeader } from "./PanelHeader";

export function MembersPanel({ channel, onClose }: { channel: ChannelDTO; onClose: () => void }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  const upsertChannel = useWorkspace((s) => s.upsertChannel);
  const openDm = useWorkspace((s) => s.openDm);
  const { open: openAgent } = useAgentProfile();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<ActorRef[]>([]);
  const [busy, setBusy] = useState(false);
  const isDm = channel.kind === "dm";

  const agentList = channel.members.filter((m) => m.type === "agent").map((m) => agents[m.id]).filter((a) => !!a);
  const people = channel.members.filter((m) => m.type === "user").map((m) => members[m.id]).filter((p) => !!p);
  const online = people.filter((p) => p.online);
  const offline = people.filter((p) => !p.online);

  const add = async () => {
    setBusy(true);
    try {
      for (const a of picked) await api.addChannelMember(ws, channel.id, a);
      upsertChannel({ ...channel, members: [...channel.members, ...picked] });
      setPicked([]);
      setAdding(false);
      toast.success(picked.length === 1 ? "Adicionado ao canal." : "Adicionados ao canal.");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: ActorRef) => {
    try {
      await api.removeChannelMember(ws, channel.id, a);
      upsertChannel({ ...channel, members: channel.members.filter((m) => !(m.type === a.type && m.id === a.id)) });
    } catch (err) {
      toast.error(err);
    }
  };

  const dm = async (a: ActorRef) => {
    try {
      const ch = await openDm(a);
      navigate(paths.channel(ws, ch.id));
    } catch (err) {
      toast.error(err);
    }
  };

  const Group = ({ title, children, count }: { title: string; count: number; children: React.ReactNode }) =>
    count === 0 ? null : (
      <section className="mb-4">
        <h3 className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
          {title} · {count}
        </h3>
        <ul>{children}</ul>
      </section>
    );

  return (
    <>
      <PanelHeader title="Membros" subtitle={channel.kind === "channel" ? `#${channel.name}` : undefined} onClose={onClose} />
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {!isDm &&
          (adding ? (
            <div className="mb-4 rounded-lg border border-line bg-bg p-3">
              <p className="mb-2 text-sm font-medium">Adicionar ao canal</p>
              {channel.humansOnly && <p className="mb-2 text-xs text-muted">Canal só de pessoas: agentes não podem entrar.</p>}
              <ActorPicker selected={picked} onToggle={(a) => setPicked((p) => toggleIn(p, a))} exclude={channel.members} includeAgents={!channel.humansOnly} autoFocus />
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  onClick={() => {
                    setAdding(false);
                    setPicked([]);
                  }}
                >
                  Cancelar
                </Button>
                <Button variant="primary" disabled={!picked.length} loading={busy} onClick={() => void add()}>
                  Adicionar {picked.length > 0 && `(${picked.length})`}
                </Button>
              </div>
            </div>
          ) : (
            <Button className="mb-4 w-full" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
              Adicionar pessoas ou agentes
            </Button>
          ))}

        <Group title="Agentes" count={agentList.length}>
          {agentList.map((a) => (
            <li key={a.id} className="group flex min-h-11 items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-surface-2">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => openAgent(a.id)}>
                <AgentAvatar agent={a} size="sm" showActivity />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {a.role ?? "Agente"} · {a.status === "paused" ? "Pausado" : ACTIVITY_LABEL[a.activity]}
                  </span>
                </span>
              </button>
              {!isDm && (
                <IconButton size="sm" label={`Remover ${a.name} do canal`} onClick={() => void remove({ type: "agent", id: a.id })} className="opacity-60 group-hover:opacity-100">
                  <UserMinus className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </Group>
        {[
          ["Online", online],
          ["Offline", offline],
        ].map(([title, list]) => (
          <Group key={title as string} title={title as string} count={(list as typeof people).length}>
            {(list as typeof people).map((p) => (
              <li key={p.userId} className="group flex min-h-11 items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-surface-2">
                <PersonAvatar member={p} size="sm" presence={p.online} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {p.name}
                    {p.userId === myUserId && <span className="font-normal text-muted"> (você)</span>}
                  </span>
                  <span className="block truncate text-xs text-muted">{[p.statusText, p.title].filter(Boolean).join(" · ") || (p.runnerOnline ? "Computador ligado" : "")}</span>
                </span>
                {p.userId !== myUserId && (
                  <IconButton size="sm" label={`Conversar com ${p.name}`} onClick={() => void dm({ type: "user", id: p.userId })} className="opacity-60 group-hover:opacity-100">
                    <MessageSquare className="size-4" />
                  </IconButton>
                )}
                {!isDm && p.userId !== myUserId && (
                  <IconButton size="sm" label={`Remover ${p.name} do canal`} onClick={() => void remove({ type: "user", id: p.userId })} className="opacity-60 group-hover:opacity-100">
                    <UserMinus className="size-4" />
                  </IconButton>
                )}
              </li>
            ))}
          </Group>
        ))}
      </div>
    </>
  );
}
