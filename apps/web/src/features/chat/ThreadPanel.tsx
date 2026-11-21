import { useEffect, useState } from "react";
import type { ChannelDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { errorMessage } from "../../api";
import { ErrorState, LoadingState } from "../../components/ui";
import { MessageItem } from "./MessageItem";
import { MessageList } from "./MessageList";
import { Composer, composerKey } from "./Composer";
import { PanelHeader } from "./PanelHeader";
import { PendingJobs, usePendingJobs } from "./PendingJobs";

export function ThreadPanel({ channel, rootId, onClose }: { channel: ChannelDTO; rootId: string; onClose: () => void }) {
  const root = useWorkspace((s) => s.messages[channel.id]?.items.find((m) => m.id === rootId) ?? s.threadRoots[rootId]);
  const thread = useWorkspace((s) => s.threads[rootId]);
  const loadThread = useWorkspace((s) => s.loadThread);
  const [error, setError] = useState<string | null>(null);
  const pending = usePendingJobs(channel.id, rootId);
  const footerKey = pending.map((p) => `${p.jobId}:${p.job?.status}:${p.stream?.text.length ?? 0}`).join("|");

  const load = () => {
    setError(null);
    loadThread(channel.id, rootId).catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [channel.id, rootId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const key = composerKey(channel.id, rootId);
  const count = thread?.items.length ?? root?.replyCount ?? 0;

  return (
    <>
      <PanelHeader title="Thread" subtitle={channel.kind === "channel" ? `#${channel.name}` : undefined} onClose={onClose} />
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !thread?.loaded ? (
        <LoadingState />
      ) : (
        <MessageList
          scrollKey={`thread:${rootId}`}
          messages={thread.items}
          hasMore={false}
          composerKey={key}
          header={
            <div className="border-b border-line pb-2">
              {root ? (
                <MessageItem message={root} continuation={false} composerKey={key} />
              ) : (
                <p className="px-4 py-3 text-sm text-muted">A mensagem original não está carregada.</p>
              )}
              <p className="px-4 pt-2 text-xs text-muted">{count === 0 ? "Nenhuma resposta ainda" : count === 1 ? "1 resposta" : `${count} respostas`}</p>
            </div>
          }
          footer={<PendingJobs items={pending} />}
          footerKey={footerKey}
        />
      )}
      <Composer channel={channel} threadRootId={rootId} placeholder="Responder na thread" autoFocus />
    </>
  );
}
