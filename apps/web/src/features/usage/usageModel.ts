/**
 * Lógica pura da tela "Uso": textos de origem, agrupamento por dia,
 * estado de cada ação e a lista de meses do seletor.
 */
import type { AgentActionDTO, JobStatus, UsageEntryDTO } from "@puxibot/shared";
import { startOfDay } from "../../lib/format";

export type Tone = "neutral" | "agent" | "warning" | "danger" | "success";

/** De onde veio o trabalho, em palavras simples. */
export function originLabel(
  entry: Pick<UsageEntryDTO, "origin" | "mode">,
  requester: { name?: string | null; isMe?: boolean } = {},
): string {
  if (entry.mode === "prepare") return "Preparação automática";
  switch (entry.origin) {
    case "routine":
      return "Rotina";
    case "agent":
      return "Outro agente";
    case "system":
      return "Sistema";
    case "user":
    default:
      if (requester.isMe) return "Pedido seu";
      return requester.name ? `Pedido de ${requester.name}` : "Pedido de uma pessoa";
  }
}

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  awaiting_approval: { label: "Aguardando aprovação", tone: "warning" },
  queued: { label: "Na fila", tone: "neutral" },
  assigned: { label: "Entregue a um computador", tone: "agent" },
  running: { label: "Trabalhando", tone: "agent" },
  done: { label: "Concluído", tone: "success" },
  failed: { label: "Erro", tone: "danger" },
  cancelled: { label: "Cancelado", tone: "neutral" },
};

export function jobStatus(status: JobStatus): { label: string; tone: Tone } {
  return JOB_STATUS[status] ?? { label: String(status), tone: "neutral" };
}

/** Estado de uma ação num serviço conectado ou no navegador. */
export function actionStatus(a: Pick<AgentActionDTO, "decision" | "status">): { label: string; tone: Tone } {
  if (a.decision === "denied") return { label: "negada", tone: "danger" };
  if (a.decision === "asked" && a.status === "pending") return { label: "esperando aprovação", tone: "warning" };
  if (a.status === "error") return { label: "erro", tone: "danger" };
  // Pediu aprovação e a pessoa recusou (ou o hub barrou): não chegou a rodar.
  if (a.status === "blocked") return { label: "não feita", tone: "danger" };
  return { label: "feita", tone: "success" };
}

export function actionKindLabel(kind: AgentActionDTO["kind"]): string {
  return kind === "read" ? "leitura" : "ação";
}

/** "1 ação", "3 ações" ou o texto de quando não houve nenhuma. */
export function actionCountLabel(n: number): string {
  if (n <= 0) return "sem ações em serviços externos";
  return n === 1 ? "1 ação" : `${n} ações`;
}

export interface DayGroup<T> {
  /** Início do dia (hora local), em ms. */
  day: number;
  items: T[];
}

/** Agrupa por dia local, do mais novo para o mais antigo (dias e itens). */
export function groupByDay<T extends { createdAt: number }>(entries: readonly T[]): DayGroup<T>[] {
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  const groups: DayGroup<T>[] = [];
  for (const e of sorted) {
    const day = startOfDay(e.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return groups;
}

/** Junta páginas sem repetir trabalho (a paginação pode devolver o mesmo item na borda). */
export function mergeEntries(prev: readonly UsageEntryDTO[], next: readonly UsageEntryDTO[]): UsageEntryDTO[] {
  const seen = new Set(prev.map((e) => e.jobId));
  return [...prev, ...next.filter((e) => !seen.has(e.jobId))];
}

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

export interface MonthOption {
  /** "YYYY-MM" */
  value: string;
  /** "novembro de 2026" */
  label: string;
}

export function periodOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Os últimos `count` meses, começando pelo atual. */
export function lastMonths(now = Date.now(), count = 12): MonthOption[] {
  const d = new Date(now);
  let year = d.getFullYear();
  let month = d.getMonth();
  const out: MonthOption[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ value: `${year}-${String(month + 1).padStart(2, "0")}`, label: `${MONTHS[month]} de ${year}` });
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return out;
}
