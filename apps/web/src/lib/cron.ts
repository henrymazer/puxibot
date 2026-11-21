/**
 * Construtor de horário das rotinas: converte entre opções simples e expressões cron
 * (5 campos: minuto hora dia-do-mês mês dia-da-semana) e calcula as próximas execuções.
 * Testado em cron.test.ts.
 */

export type Schedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" }
  | { kind: "custom"; cron: string };

export const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
export const formatHM = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

export function toCron(s: Schedule): string {
  switch (s.kind) {
    case "daily":
      return `${s.minute} ${s.hour} * * *`;
    case "weekdays":
      return `${s.minute} ${s.hour} * * 1-5`;
    case "weekly":
      return `${s.minute} ${s.hour} * * ${s.weekday}`;
    case "interval":
      if (s.unit === "minutes") return s.every <= 1 ? "* * * * *" : `*/${s.every} * * * *`;
      return s.every <= 1 ? "0 * * * *" : `0 */${s.every} * * *`;
    case "custom":
      return s.cron.trim().replace(/\s+/g, " ");
  }
}

const NUM = /^\d{1,2}$/;
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Reconhece os formatos do construtor; o resto vira `custom`. */
export function parseCron(cron: string): Schedule {
  const norm = cron.trim().replace(/\s+/g, " ");
  const f = norm.split(" ");
  if (f.length !== 5) return { kind: "custom", cron: norm };
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (dom === "*" && mon === "*" && dow === "*") {
    if (mi === "*" && h === "*") return { kind: "interval", every: 1, unit: "minutes" };
    const stepM = /^(?:\*|0)\/(\d{1,2})$/.exec(mi);
    if (stepM && h === "*") {
      const n = Number(stepM[1]);
      if (n >= 1 && n <= 59) return { kind: "interval", every: n, unit: "minutes" };
    }
    if (mi === "0") {
      if (h === "*") return { kind: "interval", every: 1, unit: "hours" };
      const stepH = /^(?:\*|0)\/(\d{1,2})$/.exec(h);
      if (stepH) {
        const n = Number(stepH[1]);
        if (n >= 1 && n <= 23) return { kind: "interval", every: n, unit: "hours" };
      }
    }
  }
  if (!NUM.test(mi) || !NUM.test(h) || dom !== "*" || mon !== "*") return { kind: "custom", cron: norm };
  const minute = Number(mi);
  const hour = Number(h);
  if (minute > 59 || hour > 23) return { kind: "custom", cron: norm };
  if (dow === "*") return { kind: "daily", hour, minute };
  const d = dow.toLowerCase();
  if (d === "1-5" || d === "mon-fri") return { kind: "weekdays", hour, minute };
  const single = NUM.test(d) ? Number(d) : DOW_NAMES[d];
  if (single !== undefined && single >= 0 && single <= 7) return { kind: "weekly", weekday: single % 7, hour, minute };
  return { kind: "custom", cron: norm };
}

export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case "daily":
      return `Todo dia às ${formatHM(s.hour, s.minute)}`;
    case "weekdays":
      return `Dias úteis às ${formatHM(s.hour, s.minute)}`;
    case "weekly": {
      const day = WEEKDAYS[s.weekday]!;
      const prefix = s.weekday === 0 || s.weekday === 6 ? "Todo" : "Toda";
      return `${prefix} ${day} às ${formatHM(s.hour, s.minute)}`;
    }
    case "interval":
      if (s.unit === "minutes") return s.every === 1 ? "A cada minuto" : `A cada ${s.every} minutos`;
      return s.every === 1 ? "A cada hora" : `A cada ${s.every} horas`;
    case "custom":
      return `Personalizado (${s.cron})`;
  }
}

export const describeCron = (cron: string) => describeSchedule(parseCron(cron));

// ---------- Validação e próximas execuções ----------
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const FIELD_NAMES = ["minuto", "hora", "dia do mês", "mês", "dia da semana"];

function expandField(field: string, idx: number): Set<number> | string {
  const [lo, hi] = RANGES[idx]!;
  const out = new Set<number>();
  for (const partRaw of field.split(",")) {
    let part = partRaw.toLowerCase();
    if (idx === 4) part = part.replace(/sun|mon|tue|wed|thu|fri|sat/g, (m) => String(DOW_NAMES[m]));
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return `"${partRaw}" não é válido no campo ${FIELD_NAMES[idx]}.`;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return `O passo no campo ${FIELD_NAMES[idx]} precisa ser maior que zero.`;
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1]!.split("-").map(Number);
      a = x!;
      b = y ?? (m[2] ? hi : x!);
    }
    if (a < lo || b > hi || a > b) return `O campo ${FIELD_NAMES[idx]} aceita de ${lo} a ${hi}.`;
    for (let v = a; v <= b; v += step) out.add(idx === 4 ? v % 7 : v);
  }
  return out;
}

/** Mensagem de erro em português, ou null se a expressão é válida. */
export function validateCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || f[0] === "") return "Use 5 campos: minuto, hora, dia do mês, mês e dia da semana.";
  for (let i = 0; i < 5; i++) {
    const r = expandField(f[i]!, i);
    if (typeof r === "string") return r;
  }
  return null;
}

interface Parsed {
  sets: Set<number>[];
  domAny: boolean;
  dowAny: boolean;
}
function compile(cron: string): Parsed | null {
  if (validateCron(cron)) return null;
  const f = cron.trim().split(/\s+/);
  return { sets: f.map((x, i) => expandField(x, i) as Set<number>), domAny: f[2] === "*", dowAny: f[4] === "*" };
}

interface WallClock {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function wallClock(ms: number, timeZone?: string): WallClock {
  if (!timeZone) {
    const d = new Date(ms);
    return { minute: d.getMinutes(), hour: d.getHours(), day: d.getDate(), month: d.getMonth() + 1, weekday: d.getDay() };
  }
  let fmt = fmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    fmtCache.set(timeZone, fmt);
  }
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(ms)) p[part.type] = part.value;
  return {
    minute: Number(p.minute),
    hour: Number(p.hour) % 24,
    day: Number(p.day),
    month: Number(p.month),
    weekday: DOW_NAMES[(p.weekday ?? "").toLowerCase()] ?? 0,
  };
}

function matches(c: Parsed, w: WallClock): boolean {
  const [mi, h, dom, mon, dow] = c.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!mi.has(w.minute) || !h.has(w.hour) || !mon.has(w.month)) return false;
  // Regra do cron: se dia do mês e dia da semana estão restritos, vale qualquer um dos dois.
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow.has(w.weekday);
  if (c.dowAny) return dom.has(w.day);
  return dom.has(w.day) || dow.has(w.weekday);
}

const MIN = 60_000;

/**
 * Próximas execuções depois de `from` (exclusivo), no fuso pedido (padrão: o do navegador).
 * Procura até `horizonDays` dias à frente.
 */
export function nextRuns(cron: string, from: number, count = 3, timeZone?: string, horizonDays = 35): number[] {
  const c = compile(cron);
  if (!c) return [];
  const out: number[] = [];
  let t = Math.floor(from / MIN) * MIN + MIN;
  const end = from + horizonDays * 24 * 60 * MIN;
  while (t <= end && out.length < count) {
    const w = wallClock(t, timeZone);
    if (matches(c, w)) {
      out.push(t);
      t += MIN;
      continue;
    }
    // Pula a hora inteira quando a hora não serve (fusos com deslocamento em minutos continuam corretos
    // porque o salto é só até o próximo minuto 0 local).
    if (!c.sets[1]!.has(w.hour)) t += (60 - w.minute) * MIN;
    else t += MIN;
  }
  return out;
}

export function nextRun(cron: string, from: number, timeZone?: string): number | null {
  return nextRuns(cron, from, 1, timeZone)[0] ?? null;
}

/** Fusos mais usados, com o do navegador primeiro. */
export function commonTimezones(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  const list = [
    "America/Sao_Paulo",
    "America/Manaus",
    "America/Recife",
    "America/Fortaleza",
    "America/Belem",
    "America/Cuiaba",
    "America/Rio_Branco",
    "America/Noronha",
    "Europe/Lisbon",
    "UTC",
  ].filter((z) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: z });
      return true;
    } catch {
      return false;
    }
  });
  return [local, ...list.filter((z) => z !== local)];
}
