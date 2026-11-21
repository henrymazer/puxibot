import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../../store/workspace";
import { initialProgress, loadProgress, saveProgress, type OnboardingProgress } from "./progress";

/** Progresso do guia do workspace aberto, salvo no aparelho. `stored` = já existe registro salvo. */
export function useOnboardingProgress(ws: string) {
  const kind = useWorkspace((s) => s.workspace?.kind ?? "team");
  const [state, setState] = useState<{ p: OnboardingProgress; stored: boolean }>(() => {
    const saved = loadProgress(ws);
    return { p: saved ?? initialProgress(kind), stored: !!saved };
  });

  useEffect(() => {
    const saved = loadProgress(ws);
    setState({ p: saved ?? initialProgress(kind), stored: !!saved });
  }, [ws, kind]);

  const update = useCallback(
    (fn: (p: OnboardingProgress) => OnboardingProgress) => {
      setState((cur) => {
        const p = fn(cur.p);
        saveProgress(ws, p);
        return { p, stored: true };
      });
    },
    [ws],
  );

  return { progress: state.p, stored: state.stored, update };
}
