/**
 * Avaliador de cron de 5 campos (minuto hora dia-do-mês mês dia-da-semana) num fuso IANA, sem dependências.
 *
 * Sintaxe: `*`, números, listas `a,b`, intervalos `a-b`, passos `*\/n` e `a-b/n`; nomes `jan..dec` e `sun..sat`;
 * dia da semana 0-7 (0 e 7 = domingo). Como no cron clássico, se dia-do-mês e dia-da-semana forem ambos
 * restritos, basta um deles casar.
 *
 * Horário de verão:
 * - horário local que não existe (o relógio pula, ex.: 02:30 no dia em que vai de 02:00 para 03:00) roda no
 *   primeiro instante depois do pulo (mesmo deslocamento: 03:30);
 * - horário local que existe duas vezes (o relógio volta) roda uma vez só, na primeira ocorrência.
 */

export interface CronSpec {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export class CronError extends Error {}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseValue(raw: string, min: number, max: number, names?: string[], nameBase = 0): number {
  const lower = raw.toLowerCase();
  if (names) {
    const idx = names.indexOf(lower);
    if (idx >= 0) return idx + nameBase;
  }
  if (!/^\d+$/.test(raw)) throw new CronError(`valor inválido "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new CronError(`valor ${n} fora do intervalo ${min}-${max}`);
  return n;
}

function parseField(field: string, min: number, max: number, names?: string[], nameBase = 0): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) throw new CronError("lista com item vazio");
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined || rangePart === undefined) throw new CronError(`passo inválido "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new CronError(`passo inválido "${part}"`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b, more] = rangePart.split("-");
      if (a === undefined || b === undefined || more !== undefined) throw new CronError(`intervalo inválido "${part}"`);
      lo = parseValue(a, min, max, names, nameBase);
      hi = parseValue(b, min, max, names, nameBase);
      if (lo > hi) throw new CronError(`intervalo invertido "${part}"`);
    } else {
      lo = parseValue(rangePart, min, max, names, nameBase);
      hi = stepPart !== undefined ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("a expressão precisa ter 5 campos (minuto hora dia mês dia-da-semana)");
  const [mi, ho, dom, mon, dow] = fields as [string, string, string, string, string];
  const weekdays = new Set(parseField(dow, 0, 7, DAY_NAMES).map((d) => (d === 7 ? 0 : d)));
  return {
    minutes: parseField(mi, 0, 59),
    hours: parseField(ho, 0, 23),
    days: new Set(parseField(dom, 1, 31)),
    months: new Set(parseField(mon, 1, 12, MONTH_NAMES, 1)),
    weekdays,
    dayRestricted: dom !== "*" && !dom.startsWith("*/"),
    weekdayRestricted: dow !== "*" && !dow.startsWith("*/"),
  };
}

// ---------- Fusos via Intl ----------
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone).format(0);
    return true;
  } catch {
    return false;
  }
}

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function localParts(t: number, timeZone: string): LocalTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(t))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Diferença (ms) entre o relógio local e o UTC no instante `t`. */
function offsetAt(t: number, timeZone: string): number {
  const p = localParts(t, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * Instante UTC de um horário local. Ambíguo: a primeira ocorrência. Inexistente (pulo do horário de verão):
 * deslocado para depois do pulo.
 */
export function zonedToUtc(local: LocalTime, timeZone: string): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set([offsetAt(guess - 14 * 3_600_000, timeZone), offsetAt(guess, timeZone), offsetAt(guess + 14 * 3_600_000, timeZone)]);
  const valid: number[] = [];
  for (const o of offsets) {
    const t = guess - o;
    const p = localParts(t, timeZone);
    if (p.year === local.year && p.month === local.month && p.day === local.day && p.hour === local.hour && p.minute === local.minute) {
      valid.push(t);
    }
  }
  if (valid.length) return Math.min(...valid);
  // Horário que não existe: usa o deslocamento de antes do pulo.
  return guess - offsetAt(guess - 14 * 3_600_000, timeZone);
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domOk = spec.days.has(day);
  const dowOk = spec.weekdays.has(weekday);
  if (spec.dayRestricted && spec.weekdayRestricted) return domOk || dowOk;
  if (spec.dayRestricted) return domOk;
  if (spec.weekdayRestricted) return dowOk;
  return domOk && dowOk;
}

/** Próximo instante (ms, estritamente depois de `after`) em que a expressão casa no fuso. `null` se nunca. */
export function nextCronRun(expr: string | CronSpec, timeZone: string, after: number): number | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  if (!isValidTimeZone(timeZone)) throw new CronError(`fuso horário desconhecido: ${timeZone}`);
  const start = localParts(after, timeZone);
  // Percorre dias locais (até ~4 anos, para cobrir 29/02) a partir do dia de `after` (um dia antes, por segurança no horário de verão).
  let cursor = Date.UTC(start.year, start.month - 1, start.day) - 86_400_000;
  for (let i = 0; i < 366 * 4 + 2; i++, cursor += 86_400_000) {
    const d = new Date(cursor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (!dayMatches(spec, year, month, day)) continue;
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const t = zonedToUtc({ year, month, day, hour, minute }, timeZone);
        if (t > after) return t;
      }
    }
  }
  return null;
}

/** Valida e devolve uma mensagem em português, ou null se estiver tudo certo. */
export function cronProblem(expr: string, timeZone: string): string | null {
  try {
    const spec = parseCron(expr);
    if (!isValidTimeZone(timeZone)) return `Fuso horário desconhecido: ${timeZone}.`;
    if (nextCronRun(spec, timeZone, Date.now()) === null) return "Essa expressão cron nunca vai disparar.";
    return null;
  } catch (err) {
    return `Expressão cron inválida: ${(err as Error).message}.`;
  }
}
