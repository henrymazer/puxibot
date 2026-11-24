import { useCallback, useEffect, useState } from "react";
import type { AgentDTO, AgentUsageDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import type { AgentPatch } from "../../api/client";
import { useWorkspace } from "../../store/workspace";
import { toast } from "../../components/toast";
import { cn } from "../../lib/cn";

/** Salva um PATCH do agente e atualiza o estado global. */
export function useSaveAgent(ws: string, agent: AgentDTO) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    async (patch: AgentPatch, okMessage = "Alterações salvas."): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const updated = await api.updateAgent(ws, agent.id, patch);
        // `toolPerms` no pedido traz só as chaves que mudaram: junta com as atuais.
        const merged = { ...agent, ...patch, ...(patch.toolPerms ? { toolPerms: { ...agent.toolPerms, ...patch.toolPerms } } : {}) };
        useWorkspace.getState().upsertAgent(updated && updated.id ? updated : merged);
        if (okMessage) toast.success(okMessage);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [ws, agent],
  );
  return { save, saving, error, setError };
}

export function useAgentUsage(ws: string, agentId: string, enabled: boolean) {
  const [usage, setUsage] = useState<AgentUsageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const load = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    api
      .getAgentUsage(ws, agentId)
      .then(setUsage)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [ws, agentId, enabled]);
  useEffect(load, [load]);
  return { usage, error, loading, reload: load };
}

/** Percentual usado do orçamento (o maior entre execuções e tokens), ou null sem orçamento. */
export function budgetPercent(agent: AgentDTO, usage: AgentUsageDTO | null): number | null {
  if (!usage) return null;
  const parts: number[] = [];
  if (agent.budgetRunsMonth) parts.push(usage.runs / agent.budgetRunsMonth);
  if (agent.budgetTokensMonth) parts.push((usage.inputTokens + usage.outputTokens) / agent.budgetTokensMonth);
  if (parts.length === 0) return null;
  return Math.round(Math.max(...parts) * 100);
}

export function UsageBar({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const tone = percent >= 100 ? "bg-danger" : percent >= 80 ? "bg-warning" : "bg-primary";
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className={cn("font-semibold", percent >= 80 && "text-warning", percent >= 100 && "text-danger")}>{percent}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={cn("h-full rounded-full transition-[width]", tone)} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

/** Controle segmentado acessível (radiogroup). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-md border border-line bg-surface-2 p-0.5", disabled && "opacity-60")}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={cn(
            "h-8 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap max-md:h-10",
            value === o.id ? "bg-elevated text-ink shadow-soft" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
