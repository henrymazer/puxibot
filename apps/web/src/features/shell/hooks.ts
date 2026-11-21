import { createContext, useCallback, useContext } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useWorkspace } from "../../store/workspace";

export interface ShellContextValue {
  openNav: () => void;
  closeNav: () => void;
  openSwitcher: () => void;
}
export const ShellContext = createContext<ShellContextValue>({
  openNav: () => undefined,
  closeNav: () => undefined,
  openSwitcher: () => undefined,
});
export const useShell = () => useContext(ShellContext);

/** Id do workspace da URL. */
export function useWsId(): string {
  return useParams().ws ?? "";
}

/** Abre/fecha o perfil de agente (`?agente=<id>`), disponível em qualquer tela do workspace. */
export function useAgentProfile() {
  const [params, setParams] = useSearchParams();
  const agentId = params.get("agente");
  const tab = params.get("aba");
  const open = useCallback(
    (id: string, aba?: string) => {
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.set("agente", id);
        if (aba) n.set("aba", aba);
        else n.delete("aba");
        return n;
      });
    },
    [setParams],
  );
  const close = useCallback(() => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete("agente");
      n.delete("aba");
      return n;
    });
  }, [setParams]);
  const setTab = useCallback(
    (aba: string) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.set("aba", aba);
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { agentId, tab, open, close, setTab };
}

export function useMe() {
  return useWorkspace((s) => s.me);
}
