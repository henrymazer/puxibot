/** Monta a linha do tempo do chat: separadores de dia, marcador "Novas" e agrupamento por autor. */
import type { MessageDTO } from "@puxibot/shared";
import { formatDayLabel, startOfDay } from "./format";

export type TimelineItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string }
  | { kind: "message"; key: string; message: MessageDTO; continuation: boolean };

/** Mensagens do mesmo autor com até este intervalo entram no mesmo grupo. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface TimelineOptions {
  /** Id da primeira mensagem não lida (recebe o marcador "Novas"). */
  firstUnreadId?: string | null;
  now?: number;
}

function sameAuthor(a: MessageDTO, b: MessageDTO): boolean {
  return a.author.type === b.author.type && a.author.id === b.author.id;
}

export function buildTimeline(messages: MessageDTO[], opts: TimelineOptions = {}): TimelineItem[] {
  const out: TimelineItem[] = [];
  const now = opts.now ?? Date.now();
  let prev: MessageDTO | null = null;
  let prevDay: number | null = null;
  for (const m of messages) {
    const day = startOfDay(m.createdAt);
    let breakGroup = false;
    if (day !== prevDay) {
      out.push({ kind: "day", key: `day-${day}`, label: formatDayLabel(m.createdAt, now) });
      prevDay = day;
      breakGroup = true;
    }
    if (opts.firstUnreadId && m.id === opts.firstUnreadId) {
      out.push({ kind: "new", key: `new-${m.id}` });
      breakGroup = true;
    }
    const continuation =
      !breakGroup &&
      prev !== null &&
      m.author.type !== "system" &&
      sameAuthor(prev, m) &&
      !prev.deleted &&
      m.createdAt - prev.createdAt <= GROUP_WINDOW_MS;
    out.push({ kind: "message", key: m.id, message: m, continuation });
    prev = m;
  }
  return out;
}

/**
 * Primeira mensagem não lida ao abrir um canal, a partir do contador do servidor.
 * Ignora mensagens da própria pessoa.
 */
export function firstUnreadId(messages: MessageDTO[], unread: number, myUserId: string | null): string | null {
  if (unread <= 0) return null;
  let remaining = unread;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.author.type === "user" && m.author.id === myUserId) continue;
    remaining--;
    if (remaining === 0) return m.id;
  }
  return messages[0]?.id ?? null;
}
