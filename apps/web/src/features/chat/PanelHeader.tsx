import type { ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { IconButton } from "../../components/ui";

export function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle?: ReactNode; onClose: () => void }) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-line px-3 pt-[env(safe-area-inset-top)] md:px-4">
      <IconButton label="Voltar" className="lg:hidden" onClick={onClose}>
        <ArrowLeft className="size-5" />
      </IconButton>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
      </div>
      <IconButton label="Fechar painel" className="max-lg:hidden" onClick={onClose}>
        <X className="size-5" />
      </IconButton>
    </header>
  );
}
