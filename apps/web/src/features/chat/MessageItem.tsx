import { memo, useRef, useState, type KeyboardEvent } from "react";
import {
  Download,
  FileText,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  Quote,
  SmilePlus,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Info,
  ListPlus,
} from "lucide-react";
import type { AttachmentDTO, MessageDTO } from "@puxibot/shared";
import { RATING_DOWN, RATING_UP, useWorkspace } from "../../store/workspace";
import { api } from "../../api";
import { toast } from "../../components/toast";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { Button, ConfirmDialog, IconButton } from "../../components/ui";
import { Popover } from "../../components/Popover";
import { actorName, CLI_LABEL, isAdmin } from "../../lib/actors";
import { formatBytes, formatDateTime, formatTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useAgentProfile } from "../shell/hooks";
import { Markdown } from "./Markdown";
import { MessageCards } from "./MessageCards";
import { useComposerStore } from "./Composer";
import { ListenButton } from "./VoiceButton";
import { useNewTask } from "../tasks/newTask";
import { prefillFromMessage } from "../../lib/kanban";

export const QUICK_EMOJIS = ["👍", "❤️", "😄", "🎉", "👀", "✅", "🙏", "🚀"];

interface Props {
  message: MessageDTO;
  continuation: boolean;
  composerKey: string;
  onOpenThread?: (rootId: string) => void;
  highlight?: boolean;
}

export const MessageItem = memo(function MessageItem({ message: m, continuation, composerKey, onOpenThread, highlight }: Props) {
  const ws = useWorkspace((s) => s.wsId)!;
  const myUserId = useWorkspace((s) => s.myUserId);
  const me = useWorkspace((s) => s.me);
  const agent = useWorkspace((s) => (m.author.type === "agent" && m.author.id ? s.agents[m.author.id] : undefined));
  const member = useWorkspace((s) => (m.author.type === "user" && m.author.id ? s.members[m.author.id] : undefined));
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const runnerMember = useWorkspace((s) => (m.meta?.runnerUserId ? s.members[m.meta.runnerUserId] : undefined));
  const { editMessage, deleteMessage, togglePin, toggleReaction, rate } = useWorkspace.getState();
  const setQuote = useComposerStore((s) => s.setQuote);
  const { open: openAgent } = useAgentProfile();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(m.body);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [selected, setSelected] = useState(false);
  const emojiAnchor = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const agentHandles = useAgentHandles();

  if (m.author.type === "system") {
    return (
      <div className="flex items-start justify-center gap-1.5 px-4 py-1.5 text-center text-xs text-muted" data-message-id={m.id}>
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{m.body}</span>
        <span className="text-subtle">· {formatTime(m.createdAt)}</span>
      </div>
    );
  }

  const mine = m.author.type === "user" && m.author.id === myUserId;
  const canDelete = mine || isAdmin(me?.role);
  const isAgent = m.author.type === "agent";
  const name = actorName({ members, agents }, m.author);
  const ratings = isAgent ? new Set([RATING_UP, RATING_DOWN]) : new Set<string>();
  const visibleReactions = m.reactions.filter((r) => !ratings.has(r.emoji));
  const myRating = isAgent
    ? m.reactions.find((r) => r.emoji === RATING_UP && myUserId && r.userIds.includes(myUserId))
      ? "up"
      : m.reactions.find((r) => r.emoji === RATING_DOWN && myUserId && r.userIds.includes(myUserId))
        ? "down"
        : null
    : null;

  const quoteSelection = () => {
    const sel = window.getSelection();
    let text = "";
    if (sel && !sel.isCollapsed && bodyRef.current && bodyRef.current.contains(sel.anchorNode)) text = sel.toString().trim();
    if (!text) text = m.body.trim();
    setQuote(composerKey, { messageId: m.id, text: text.slice(0, 2000) });
  };

  const saveEdit = async () => {
    if (!editText.trim() || editText === m.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editMessage(m.id, editText.trim());
      setEditing(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const onEditKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      setEditing(false);
      setEditText(m.body);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void saveEdit();
    }
  };

  const runner = runnerMember?.name ?? m.meta?.runnerName;

  return (
    <div
      data-message-id={m.id}
      className={cn(
        "group relative flex gap-3 px-3 md:px-5",
        continuation ? "py-0.5" : "pt-2.5 pb-0.5",
        "hover:bg-surface-2/60",
        selected && "bg-surface-2/60",
        m.pinned && "bg-warning-soft/30",
        highlight && "bg-primary-soft/50",
      )}
      onClick={(e) => {
        // Toque no celular mostra as ações.
        if (window.matchMedia("(hover: none)").matches && !(e.target as HTMLElement).closest("button,a,textarea")) setSelected((v) => !v);
      }}
    >
      <div className="w-9 shrink-0">
        {!continuation &&
          (agent ? (
            <button type="button" onClick={() => openAgent(agent.id)} aria-label={`Perfil de ${agent.name}`} className="rounded-md">
              <AgentAvatar agent={agent} />
            </button>
          ) : isAgent ? (
            <AgentAvatar agent={{ id: m.author.id ?? "x", name, avatarColor: null, avatarAccessory: null }} />
          ) : (
            <PersonAvatar member={member} name={name} />
          ))}
        {continuation && (
          <time className="hidden pt-1 text-right text-[10px] text-subtle group-hover:block" dateTime={new Date(m.createdAt).toISOString()}>
            {formatTime(m.createdAt)}
          </time>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!continuation && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            {agent ? (
              <button type="button" className="font-semibold hover:underline" onClick={() => openAgent(agent.id)}>
                {name}
              </button>
            ) : (
              <span className="font-semibold">{name}</span>
            )}
            {isAgent && <span className="rounded-xs bg-agent-soft px-1 text-[10px] font-semibold tracking-wide text-agent uppercase">agente</span>}
            <time className="text-xs text-subtle" dateTime={new Date(m.createdAt).toISOString()} title={formatDateTime(m.createdAt)}>
              {formatTime(m.createdAt)}
            </time>
            {m.pinned && (
              <span className="inline-flex items-center gap-0.5 text-xs text-warning">
                <Pin className="size-3" aria-hidden /> fixada
              </span>
            )}
          </div>
        )}

        {m.quote && (
          <blockquote className="my-1 border-l-2 border-line-strong pl-2.5 text-sm text-muted italic">
            <span className="line-clamp-3">{m.quote.text}</span>
          </blockquote>
        )}

        {editing ? (
          <div className="mt-1">
            <textarea
              className="tb-input min-h-20"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={onEditKey}
              autoFocus
              aria-label="Editar mensagem"
            />
            <div className="mt-1.5 flex gap-2">
              <Button size="sm" variant="primary" loading={saving} onClick={() => void saveEdit()}>
                Salvar
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setEditText(m.body);
                }}
              >
                Cancelar
              </Button>
              <span className="self-center text-xs text-subtle max-md:hidden">Enter salva · Esc cancela</span>
            </div>
          </div>
        ) : (
          m.body && (
            <div ref={bodyRef} className="text-[15px] leading-relaxed">
              <Markdown text={m.body} agentHandles={agentHandles} />
              {m.editedAt && <span className="ml-1 text-xs text-subtle" title={formatDateTime(m.editedAt)}>(editada)</span>}
            </div>
          )
        )}

        {m.attachments.length > 0 && <Attachments ws={ws} items={m.attachments} />}
        <MessageCards cards={m.cards} />

        {isAgent && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
            {(m.meta?.model || m.meta?.cli) && (
              <span title={m.meta?.runnerName ? `Executado em ${m.meta.runnerName}` : undefined}>
                {[m.meta?.model, m.meta?.cli ? CLI_LABEL[m.meta.cli] : null].filter(Boolean).join(" · ")}
                {runner && <> · no computador de {runner}</>}
              </span>
            )}
            <span className="inline-flex items-center gap-0.5" role="group" aria-label="Avaliar resposta">
              <button
                type="button"
                aria-pressed={myRating === "up"}
                aria-label="Resposta boa"
                title="Resposta boa"
                onClick={() => rate(m, "up").catch(toast.error)}
                className={cn("rounded-sm p-1 hover:bg-surface-3 max-md:p-2", myRating === "up" ? "text-success" : "text-subtle")}
              >
                <ThumbsUp className="size-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={myRating === "down"}
                aria-label="Resposta ruim"
                title="Resposta ruim"
                onClick={() => rate(m, "down").catch(toast.error)}
                className={cn("rounded-sm p-1 hover:bg-surface-3 max-md:p-2", myRating === "down" ? "text-danger" : "text-subtle")}
              >
                <ThumbsDown className="size-3.5" />
              </button>
            </span>
          </div>
        )}

        {visibleReactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {visibleReactions.map((r) => {
              const reacted = !!myUserId && r.userIds.includes(myUserId);
              const who = r.userIds.map((u) => members[u]?.name ?? "Alguém").join(", ");
              return (
                <button
                  key={r.emoji}
                  type="button"
                  aria-pressed={reacted}
                  title={who}
                  aria-label={`${r.emoji} ${r.userIds.length}, ${who}`}
                  onClick={() => toggleReaction(m, r.emoji).catch(toast.error)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs max-md:h-8",
                    reacted ? "border-primary bg-primary-soft text-primary-text" : "border-line bg-surface hover:border-line-strong",
                  )}
                >
                  <span>{r.emoji}</span>
                  <span className="tabular-nums">{r.userIds.length}</span>
                </button>
              );
            })}
          </div>
        )}

        {onOpenThread && m.replyCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenThread(m.id)}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary-text hover:bg-primary-soft max-md:py-2"
          >
            <MessageSquareReply className="size-3.5" aria-hidden />
            {m.replyCount === 1 ? "1 resposta" : `${m.replyCount} respostas`}
          </button>
        )}
      </div>

      {!editing && (
        <div
          role="toolbar"
          aria-label="Ações da mensagem"
          className={cn(
            "absolute -top-3 right-3 z-10 items-center rounded-md border border-line bg-elevated p-0.5 shadow-soft md:right-5",
            selected || emojiOpen ? "flex" : "hidden group-hover:flex group-focus-within:flex",
          )}
        >
          <IconButton ref={emojiAnchor} size="sm" label="Reagir" onClick={() => setEmojiOpen((v) => !v)}>
            <SmilePlus className="size-4" />
          </IconButton>
          {onOpenThread && (
            <IconButton size="sm" label="Responder em thread" onClick={() => onOpenThread(m.id)}>
              <MessageSquareReply className="size-4" />
            </IconButton>
          )}
          <IconButton
            size="sm"
            label="Citar (selecione um trecho antes para citar só ele)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={quoteSelection}
          >
            <Quote className="size-4" />
          </IconButton>
          {isAgent && m.body.trim() && <ListenButton messageId={m.id} text={m.body} />}
          <IconButton
            size="sm"
            label="Criar tarefa a partir desta mensagem"
            onClick={() => {
              setSelected(false);
              useNewTask.getState().open({ ...prefillFromMessage(m.body), sourceMessageId: m.id, sourceChannelId: m.channelId });
            }}
          >
            <ListPlus className="size-4" />
          </IconButton>
          <IconButton size="sm" label={m.pinned ? "Desafixar" : "Fixar no canal"} onClick={() => togglePin(m).catch(toast.error)}>
            {m.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </IconButton>
          {mine && (
            <IconButton
              size="sm"
              label="Editar"
              onClick={() => {
                setEditText(m.body);
                setEditing(true);
              }}
            >
              <Pencil className="size-4" />
            </IconButton>
          )}
          {canDelete && (
            <IconButton size="sm" label="Apagar" onClick={() => setConfirmDelete(true)} className="hover:text-danger">
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>
      )}

      <Popover open={emojiOpen} onClose={() => setEmojiOpen(false)} anchor={emojiAnchor} align="end" label="Escolher reação" className="p-1.5">
        <div className="grid grid-cols-8 gap-0.5 max-md:grid-cols-4 max-md:p-3">
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`Reagir com ${e}`}
              className="flex size-9 items-center justify-center rounded-md text-lg hover:bg-surface-2 max-md:size-14 max-md:text-2xl"
              onClick={() => {
                setEmojiOpen(false);
                toggleReaction(m, e).catch(toast.error);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </Popover>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          deleteMessage(m).catch(toast.error);
        }}
        title="Apagar mensagem?"
        body="Ela some da conversa para todo mundo."
        confirmLabel="Apagar"
        danger
      />
    </div>
  );
});

function useAgentHandles(): Set<string> {
  const agents = useWorkspace((s) => s.agents);
  const ref = useRef<{ src: typeof agents; set: Set<string> } | null>(null);
  if (!ref.current || ref.current.src !== agents) {
    ref.current = { src: agents, set: new Set(Object.values(agents).map((a) => a.handle)) };
  }
  return ref.current.set;
}

function Attachments({ ws, items }: { ws: string; items: AttachmentDTO[] }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-2">
      {items.map((a) => {
        const url = api.fileUrl(ws, a.fileId);
        if (a.mime.startsWith("image/")) {
          return (
            <li key={a.fileId}>
              <a href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md border border-line">
                <img src={url} alt={a.name} loading="lazy" className="max-h-64 max-w-[min(100%,20rem)] object-cover" />
              </a>
            </li>
          );
        }
        return (
          <li key={a.fileId} className="max-w-full">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              download={a.name}
              className="flex max-w-xs items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 hover:border-line-strong"
            >
              <FileText className="size-5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.name}</span>
                <span className="block text-xs text-subtle">{formatBytes(a.size)}</span>
              </span>
              <Download className="size-4 shrink-0 text-muted" aria-label="Baixar" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
