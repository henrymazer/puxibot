import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { create } from "zustand";
import { ArrowUp, FileText, Loader2, Paperclip, Quote, X } from "lucide-react";
import type { ChannelDTO, FileDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { api } from "../../api";
import { toast } from "../../components/toast";
import { IconButton } from "../../components/ui";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { applyMention, filterMentionCandidates, getMentionQuery, type MentionCandidate, type MentionQuery } from "../../lib/mentions";
import { actorName } from "../../lib/actors";
import { memberHandle } from "../../lib/handles";
import { typingActors } from "../../realtime/reducer";
import { formatBytes } from "../../lib/format";
import { cn } from "../../lib/cn";

/** Citações e rascunhos por campo de mensagem ("main:<canal>" ou "thread:<raiz>"). */
interface ComposerStore {
  quotes: Record<string, { messageId: string; text: string } | undefined>;
  drafts: Record<string, string>;
  setQuote: (key: string, q: { messageId: string; text: string } | undefined) => void;
  setDraft: (key: string, text: string) => void;
}
export const useComposerStore = create<ComposerStore>((set) => ({
  quotes: {},
  drafts: {},
  setQuote: (key, q) => set((s) => ({ quotes: { ...s.quotes, [key]: q } })),
  setDraft: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
}));
export const composerKey = (channelId: string, threadRootId?: string | null) =>
  threadRootId ? `thread:${threadRootId}` : `main:${channelId}`;

interface Upload {
  localId: string;
  file: File;
  status: "uploading" | "done" | "error";
  result?: FileDTO;
}

const MAX_FILE = 25 * 1024 * 1024;

export function Composer({
  channel,
  threadRootId,
  placeholder,
  autoFocus,
}: {
  channel: ChannelDTO;
  threadRootId?: string;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const key = composerKey(channel.id, threadRootId);
  const ws = useWorkspace((s) => s.wsId)!;
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const typing = useWorkspace((s) => s.typing);
  const sendMessage = useWorkspace((s) => s.sendMessage);
  const notifyTyping = useWorkspace((s) => s.notifyTyping);
  const quote = useComposerStore((s) => s.quotes[key]);
  const setQuote = useComposerStore((s) => s.setQuote);
  const draft = useComposerStore((s) => s.drafts[key] ?? "");
  const setDraft = useComposerStore((s) => s.setDraft);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Autoajuste da altura.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [draft]);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(min-width: 768px)").matches) taRef.current?.focus();
  }, [autoFocus, channel.id]);

  useEffect(() => {
    if (quote) taRef.current?.focus();
  }, [quote]);

  // Indicador de digitação: re-renderiza enquanto houver alguém digitando.
  const typingKeys = typingActors({ typing }, channel.id, now);
  useEffect(() => {
    if (!typing[channel.id]) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [typing, channel.id]);

  const candidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    if (!channel.humansOnly) {
      for (const a of Object.values(agents)) out.push({ type: "agent", id: a.id, handle: a.handle, name: a.name, detail: a.role });
    }
    for (const m of Object.values(members)) out.push({ type: "user", id: m.userId, handle: memberHandle(m), name: m.name, detail: m.title });
    return out;
  }, [agents, members, channel.humansOnly]);
  const suggestions = mention ? filterMentionCandidates(candidates, mention.query) : [];

  const updateMention = (text: string, caret: number) => {
    const q = getMentionQuery(text, caret);
    setMention(q);
    setMentionIdx(0);
  };

  const pick = (c: MentionCandidate) => {
    const ta = taRef.current;
    if (!ta || !mention) return;
    const r = applyMention(draft, mention, ta.selectionStart, c.handle);
    setDraft(key, r.text);
    setMention(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.caret, r.caret);
    });
  };

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE) {
        toast.error(new Error(`"${file.name}" tem mais de 25 MB.`));
        continue;
      }
      const localId = `${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { localId, file, status: "uploading" }]);
      api
        .uploadFile(ws, file, { channelId: channel.id })
        .then((result) => setUploads((u) => u.map((x) => (x.localId === localId ? { ...x, status: "done", result } : x))))
        .catch((err) => {
          toast.error(err);
          setUploads((u) => u.map((x) => (x.localId === localId ? { ...x, status: "error" } : x)));
        });
    }
  };

  const uploading = uploads.some((u) => u.status === "uploading");
  const ready = uploads.filter((u) => u.status === "done" && u.result);
  const canSend = !sending && !uploading && (draft.trim().length > 0 || ready.length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await sendMessage(channel.id, {
        body: draft.trim(),
        threadRootId,
        quote,
        attachmentIds: ready.length ? ready.map((u) => u.result!.id) : undefined,
      });
      setDraft(key, "");
      setQuote(key, undefined);
      setUploads([]);
      setMention(null);
    } catch (err) {
      toast.error(err);
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[mentionIdx]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Enter envia no desktop; no celular, Enter quebra linha e o botão envia.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(min-width: 768px)").matches) {
      e.preventDefault();
      void send();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const typingNames = typingKeys.map((k) => {
    const [type, id] = k.split(":");
    return actorName({ members, agents }, { type: type!, id: id ?? null });
  });
  const listId = `mentions-${key}`;

  return (
    <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5">
      <div
        className={cn(
          "relative rounded-lg border bg-surface shadow-soft transition-colors focus-within:border-primary",
          dragging ? "border-primary bg-primary-soft" : "border-line-strong",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {mention && suggestions.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Sugestões de menção"
            className="tb-anim-pop absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-lg border border-line bg-elevated py-1 shadow-pop"
          >
            {suggestions.map((c, i) => {
              const agent = c.type === "agent" ? agents[c.id] : undefined;
              const member = c.type === "user" ? members[c.id] : undefined;
              return (
                <li
                  key={`${c.type}:${c.id}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === mentionIdx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(c);
                  }}
                  onMouseMove={() => setMentionIdx(i)}
                  className={cn("flex min-h-10 cursor-pointer items-center gap-2.5 px-3 py-1.5 max-md:min-h-12", i === mentionIdx && "bg-primary-soft")}
                >
                  {agent ? <AgentAvatar agent={agent} size="sm" /> : <PersonAvatar member={member} size="sm" presence={member?.online} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-muted">
                      @{c.handle}
                      {c.detail ? ` · ${c.detail}` : ""}
                    </span>
                  </span>
                  {c.type === "agent" && <span className="rounded-xs bg-agent-soft px-1.5 text-[11px] font-medium text-agent">agente</span>}
                </li>
              );
            })}
          </ul>
        )}

        {quote && (
          <div className="flex items-start gap-2 border-b border-line px-3 py-2 text-sm">
            <Quote className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <p className="line-clamp-2 flex-1 text-muted italic">{quote.text}</p>
            <IconButton label="Remover citação" size="sm" onClick={() => setQuote(key, undefined)}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}

        {uploads.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-b border-line px-3 py-2" aria-label="Anexos">
            {uploads.map((u) => (
              <li
                key={u.localId}
                className={cn(
                  "flex max-w-[16rem] items-center gap-2 rounded-md border px-2 py-1 text-xs",
                  u.status === "error" ? "border-danger/50 bg-danger-soft" : "border-line bg-surface-2",
                )}
              >
                {u.status === "uploading" ? <Loader2 className="size-3.5 animate-spin" aria-label="Enviando" /> : <FileText className="size-3.5 text-muted" aria-hidden />}
                <span className="truncate">{u.file.name}</span>
                <span className="text-subtle">{u.status === "error" ? "falhou" : formatBytes(u.file.size)}</span>
                <button type="button" aria-label={`Remover ${u.file.name}`} className="text-muted hover:text-ink" onClick={() => setUploads((x) => x.filter((y) => y.localId !== u.localId))}>
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-1 p-1.5">
          <IconButton label="Anexar arquivo" onClick={() => fileRef.current?.click()}>
            <Paperclip className="size-4.5" />
          </IconButton>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            placeholder={placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={!!mention && suggestions.length > 0}
            aria-controls={mention && suggestions.length ? listId : undefined}
            aria-activedescendant={mention && suggestions.length ? `${listId}-${mentionIdx}` : undefined}
            onChange={(e) => {
              setDraft(key, e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
              if (e.target.value) notifyTyping(channel.id);
            }}
            onSelect={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setTimeout(() => setMention(null), 150)}
            className="tb-scroll max-h-60 min-h-10 flex-1 resize-none bg-transparent px-1.5 py-2 leading-normal outline-none placeholder:text-subtle"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="Enviar"
            title="Enviar (Enter)"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-fg transition-opacity hover:bg-primary-hover disabled:opacity-35"
          >
            {sending ? <Loader2 className="size-4.5 animate-spin" /> : <ArrowUp className="size-4.5" />}
          </button>
        </div>
      </div>
      <div className="flex h-5 items-center px-1 text-xs text-muted" aria-live="polite">
        {typingNames.length > 0 ? (
          <span>
            <span className="tb-dot-pulse mr-1 inline-block size-1.5 rounded-full bg-muted align-middle" />
            {typingNames.length === 1 ? `${typingNames[0]} está digitando…` : `${typingNames.slice(0, 2).join(" e ")} estão digitando…`}
          </span>
        ) : (
          <span className="hidden md:inline text-subtle">Enter envia · Shift+Enter quebra linha · @ chama alguém</span>
        )}
      </div>
    </div>
  );
}
