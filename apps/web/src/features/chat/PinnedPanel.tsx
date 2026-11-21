import { useEffect, useState } from "react";
import { Pin } from "lucide-react";
import type { ChannelDTO, MessageDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { api, errorMessage } from "../../api";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui";
import { actorName } from "../../lib/actors";
import { formatDateTime } from "../../lib/format";
import { Markdown } from "./Markdown";
import { PanelHeader } from "./PanelHeader";

export function PinnedPanel({ channel, onClose, onJump }: { channel: ChannelDTO; onClose: () => void; onJump: (m: MessageDTO) => void }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  // Recarrega quando alguma mensagem visível muda de estado "fixada".
  const pinnedSig = useWorkspace((s) => s.messages[channel.id]?.items.filter((m) => m.pinned).map((m) => m.id).join(",") ?? "");
  const [items, setItems] = useState<MessageDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api
      .listMessages(ws, channel.id, { pinned: true, limit: 100 })
      .then((list) => setItems(list.filter((m) => m.pinned).reverse()))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [ws, channel.id, pinnedSig]);

  return (
    <>
      <PanelHeader title="Mensagens fixadas" subtitle={channel.kind === "channel" ? `#${channel.name}` : undefined} onClose={onClose} />
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !items ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState icon={<Pin className="size-5" />} title="Nada fixado ainda">
            Passe o mouse numa mensagem (ou toque nela no celular) e escolha “Fixar no canal”.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onJump(m)} className="w-full rounded-lg border border-line bg-bg p-3 text-left hover:border-line-strong">
                  <div className="mb-1 flex items-baseline gap-2 text-xs">
                    <span className="font-semibold text-ink">{actorName({ members, agents }, m.author)}</span>
                    <span className="text-subtle">{formatDateTime(m.createdAt)}</span>
                  </div>
                  <div className="line-clamp-4 text-sm">
                    <Markdown text={m.body} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
