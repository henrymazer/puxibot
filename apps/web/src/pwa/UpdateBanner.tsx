import { RefreshCw, X } from "lucide-react";
import { usePwa } from "./register";
import { Button, IconButton } from "../components/ui";

/** "Nova versão disponível": troca de versão só quando a pessoa pede, sem perder o que está digitando. */
export function UpdateBanner() {
  const waiting = usePwa((s) => s.waiting);
  const apply = usePwa((s) => s.applyUpdate);
  const dismiss = usePwa((s) => s.dismissUpdate);
  if (!waiting) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[65] flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:justify-start md:pl-[calc(var(--tb-sidebar-w)+1rem)]">
      <div role="status" className="tb-anim-pop pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-lg border border-line bg-elevated px-3 py-2 shadow-pop">
        <RefreshCw className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="flex-1 text-sm">Nova versão do Puxibot disponível.</span>
        <Button size="sm" variant="primary" onClick={apply}>
          Atualizar
        </Button>
        <IconButton size="sm" label="Agora não" onClick={dismiss}>
          <X className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}
