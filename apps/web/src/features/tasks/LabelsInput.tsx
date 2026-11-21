import { useId, useState } from "react";
import { LabelChip } from "./TaskBits";

/** Etiquetas: Enter ou vírgula adiciona; × tira. */
export function LabelsInput({ value, onChange, suggestions = [], disabled }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; disabled?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const l = raw.trim().replace(/,$/, "").slice(0, 40);
    if (!l || value.includes(l) || value.length >= 10) return;
    onChange([...value, l]);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Etiquetas
      </label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1.5 focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--tb-primary-soft)]">
        {value.map((l) => (
          <LabelChip key={l} label={l} onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== l))} />
        ))}
        <input
          id={id}
          value={draft}
          disabled={disabled || value.length >= 10}
          list={`${id}-list`}
          onChange={(e) => {
            const v = e.target.value;
            if (v.endsWith(",")) {
              add(v);
              setDraft("");
            } else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
              setDraft("");
            }
            if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => {
            if (draft.trim()) {
              add(draft);
              setDraft("");
            }
          }}
          placeholder={value.length ? "" : "Ex.: urgente, clientes"}
          className="min-h-7 min-w-24 flex-1 bg-transparent text-sm outline-none max-md:min-h-9"
          aria-describedby={`${id}-hint`}
        />
        <datalist id={`${id}-list`}>
          {suggestions
            .filter((s) => !value.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted">
        Enter ou vírgula adiciona. Até 10.
      </p>
    </div>
  );
}
