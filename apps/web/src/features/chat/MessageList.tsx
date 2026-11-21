import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import type { MessageDTO } from "@puxibot/shared";
import { buildTimeline } from "../../lib/timeline";
import { Spinner } from "../../components/ui";
import { toast } from "../../components/toast";
import { MessageItem } from "./MessageItem";
import { useWorkspace } from "../../store/workspace";

const NEAR_BOTTOM = 140;

export function MessageList({
  scrollKey,
  messages,
  hasMore,
  onLoadOlder,
  firstUnreadId,
  composerKey,
  onOpenThread,
  header,
  footer,
  footerKey,
  highlightId,
}: {
  scrollKey: string;
  messages: MessageDTO[];
  hasMore: boolean;
  onLoadOlder?: () => Promise<void>;
  firstUnreadId?: string | null;
  composerKey: string;
  onOpenThread?: (id: string) => void;
  header?: ReactNode;
  footer?: ReactNode;
  /** Muda quando o rodapé (respostas em andamento) cresce, para manter o fim visível. */
  footerKey?: string;
  highlightId?: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevHeight = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [loading, setLoading] = useState(false);
  const initialScrollDone = useRef<string | null>(null);

  const items = useMemo(() => buildTimeline(messages, { firstUnreadId }), [messages, firstUnreadId]);
  const firstId = messages[0]?.id;
  const lastId = messages[messages.length - 1]?.id;

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Posição inicial: marcador "Novas" (ou mensagem destacada), senão o fim.
  useLayoutEffect(() => {
    if (initialScrollDone.current === scrollKey || messages.length === 0) return;
    initialScrollDone.current = scrollKey;
    const el = scroller.current;
    if (!el) return;
    const target = highlightId
      ? el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(highlightId)}"]`)
      : firstUnreadId
        ? el.querySelector<HTMLElement>("[data-new-marker]")
        : null;
    if (target) {
      el.scrollTop = target.offsetTop - 80;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    } else {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
    }
  }, [scrollKey, messages.length, firstUnreadId, highlightId]);

  // Mantém a posição ao inserir mensagens antigas no topo.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    }
  }, [firstId]);

  // Mensagem nova ou texto em streaming: acompanha o fim se a pessoa já estava lá.
  const myUserId = useWorkspace((s) => s.myUserId);
  const lastMine = messages[messages.length - 1]?.author.id === myUserId;
  useLayoutEffect(() => {
    if (atBottom.current || lastMine) {
      atBottom.current = true;
      scrollToBottom();
    } else if (lastId) setShowJump(true);
  }, [lastId, footerKey, scrollToBottom, lastMine]);

  const loadOlder = useCallback(async () => {
    if (!onLoadOlder || !hasMore || loadingOlder.current) return;
    loadingOlder.current = true;
    setLoading(true);
    prevHeight.current = scroller.current?.scrollHeight ?? null;
    try {
      await onLoadOlder();
    } catch (err) {
      prevHeight.current = null;
      toast.error(err);
    } finally {
      loadingOlder.current = false;
      setLoading(false);
    }
  }, [onLoadOlder, hasMore]);

  useEffect(() => {
    const el = topSentinel.current;
    const root = scroller.current;
    if (!el || !root || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && initialScrollDone.current === scrollKey) void loadOlder();
    }, { root, rootMargin: "400px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadOlder, scrollKey]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    atBottom.current = near;
    if (near) setShowJump(false);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="tb-scroll absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain"
        role="log"
        aria-label="Mensagens"
        aria-live="off"
      >
        <div ref={topSentinel} aria-hidden className="h-px" />
        {hasMore ? (
          <div className="flex justify-center py-3">{loading ? <Spinner label="Carregando mensagens antigas" /> : <button type="button" className="text-xs text-muted underline" onClick={() => void loadOlder()}>Carregar mensagens antigas</button>}</div>
        ) : (
          header
        )}
        <div className="pb-3">
          {items.map((it) => {
            if (it.kind === "day") {
              return (
                <div key={it.key} className="flex items-center gap-3 px-3 py-2 md:px-5" role="separator" aria-label={it.label}>
                  <span className="h-px flex-1 bg-line" />
                  <span className="rounded-full border border-line bg-bg px-3 py-0.5 text-xs font-medium text-muted">{it.label}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              );
            }
            if (it.kind === "new") {
              return (
                <div key={it.key} data-new-marker className="flex items-center gap-2 px-3 py-1 md:px-5" role="separator" aria-label="Mensagens novas">
                  <span className="h-px flex-1 bg-new" />
                  <span className="text-xs font-semibold text-new">Novas</span>
                </div>
              );
            }
            return (
              <MessageItem
                key={it.key}
                message={it.message}
                continuation={it.continuation}
                composerKey={composerKey}
                onOpenThread={onOpenThread}
                highlight={it.message.id === highlightId}
              />
            );
          })}
          {footer}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => {
            scrollToBottom(true);
            setShowJump(false);
          }}
          className="tb-anim-pop absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-fg shadow-pop"
        >
          <ArrowDown className="size-4" aria-hidden />
          Mensagens novas
        </button>
      )}
    </div>
  );
}
