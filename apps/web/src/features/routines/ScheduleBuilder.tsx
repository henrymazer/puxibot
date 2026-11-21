/** Construtor simples de horário que gera o cron, com campo avançado. */
import { useEffect, useId, useState } from "react";
import { describeSchedule, formatHM, nextRuns, parseCron, toCron, validateCron, WEEKDAYS, type Schedule } from "../../lib/cron";
import { Input, Select } from "../../components/ui";
import { Segmented } from "../agents/shared";

type Kind = Schedule["kind"];
const KINDS: { id: Kind; label: string }[] = [
  { id: "daily", label: "Todo dia" },
  { id: "weekdays", label: "Dias úteis" },
  { id: "weekly", label: "Toda semana" },
  { id: "interval", label: "A cada…" },
  { id: "custom", label: "Avançado" },
];

const dayTimeFmt = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
};

function timeOf(s: Schedule): { hour: number; minute: number } {
  return "hour" in s ? { hour: s.hour, minute: s.minute } : { hour: 9, minute: 0 };
}

export function ScheduleBuilder({ cron, onChange, timezone, disabled }: { cron: string; onChange: (cron: string, valid: boolean) => void; timezone: string; disabled?: boolean }) {
  const uid = useId();
  const [schedule, setSchedule] = useState<Schedule>(() => parseCron(cron || "0 9 * * *"));
  const [advanced, setAdvanced] = useState(cron || "0 9 * * *");
  const current = schedule.kind === "custom" ? advanced : toCron(schedule);
  const error = validateCron(current);

  useEffect(() => {
    onChange(current, !error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const switchKind = (k: Kind) => {
    const t = timeOf(schedule);
    const next: Schedule =
      k === "daily"
        ? { kind: "daily", ...t }
        : k === "weekdays"
          ? { kind: "weekdays", ...t }
          : k === "weekly"
            ? { kind: "weekly", weekday: schedule.kind === "weekly" ? schedule.weekday : 1, ...t }
            : k === "interval"
              ? schedule.kind === "interval"
                ? schedule
                : { kind: "interval", every: 30, unit: "minutes" }
              : { kind: "custom", cron: current };
    if (k === "custom") setAdvanced(current);
    setSchedule(next);
  };

  const setTime = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m) || !("hour" in schedule)) return;
    setSchedule({ ...schedule, hour: h!, minute: m! });
  };

  const runs = error ? [] : nextRuns(current, Date.now(), 3, timezone);
  const fmt = dayTimeFmt(timezone);

  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">Quando</legend>
      <div className="tb-scroll -mx-1 overflow-x-auto px-1 pb-0.5">
        <Segmented label="Frequência" value={schedule.kind} options={KINDS} onChange={switchKind} disabled={disabled} />
      </div>

      {"hour" in schedule && (
        <div className="flex flex-wrap items-end gap-3">
          {schedule.kind === "weekly" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${uid}-day`} className="text-xs text-muted">
                Dia
              </label>
              <Select id={`${uid}-day`} value={schedule.weekday} onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })} className="w-40">
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d.charAt(0).toUpperCase() + d.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-time`} className="text-xs text-muted">
              Horário
            </label>
            <Input id={`${uid}-time`} type="time" value={formatHM(schedule.hour, schedule.minute)} onChange={(e) => setTime(e.target.value)} className="w-32" required />
          </div>
        </div>
      )}

      {schedule.kind === "interval" && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${uid}-every`} className="text-xs text-muted">
              A cada
            </label>
            <Input
              id={`${uid}-every`}
              type="number"
              inputMode="numeric"
              min={1}
              max={schedule.unit === "minutes" ? 59 : 23}
              value={schedule.every}
              onChange={(e) => {
                const max = schedule.unit === "minutes" ? 59 : 23;
                const n = Math.max(1, Math.min(max, Math.round(Number(e.target.value) || 1)));
                setSchedule({ ...schedule, every: n });
              }}
              className="w-24"
            />
          </div>
          <Select
            aria-label="Unidade"
            value={schedule.unit}
            onChange={(e) => {
              const unit = e.target.value as "minutes" | "hours";
              setSchedule({ kind: "interval", unit, every: Math.min(schedule.every, unit === "minutes" ? 59 : 23) });
            }}
            className="w-32"
          >
            <option value="minutes">minutos</option>
            <option value="hours">horas</option>
          </Select>
        </div>
      )}

      {schedule.kind === "custom" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-cron`} className="text-xs text-muted">
            Expressão cron (minuto hora dia mês dia-da-semana)
          </label>
          <Input
            id={`${uid}-cron`}
            value={advanced}
            onChange={(e) => setAdvanced(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            className="font-mono"
            aria-invalid={!!error}
            aria-describedby={`${uid}-cron-help`}
          />
          <p id={`${uid}-cron-help`} className={error ? "text-xs text-danger" : "text-xs text-muted"} role={error ? "alert" : undefined}>
            {error ?? "Ex.: 30 8 1 * * = todo dia 1º às 08:30."}
          </p>
        </div>
      )}

      <div className="rounded-md bg-surface-2 px-3 py-2 text-sm">
        <p className="font-medium">{error ? "Horário inválido" : describeSchedule(parseCron(current))}</p>
        <p className="mt-0.5 font-mono text-xs text-subtle">{current}</p>
        {runs.length > 0 && (
          <p className="mt-1 text-xs text-muted">
            Próximas: {runs.map((r) => fmt.format(r)).join(" · ")}
          </p>
        )}
      </div>
    </fieldset>
  );
}
