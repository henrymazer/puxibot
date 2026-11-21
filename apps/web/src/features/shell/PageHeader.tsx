import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { IconButton } from "../../components/ui";
import { useShell } from "./hooks";
import { cn } from "../../lib/cn";

/** Cabeçalho de tela. No celular inclui o botão que abre a barra lateral. */
export function PageHeader({
  title,
  icon,
  subtitle,
  actions,
  className,
  subtitleWrap = false,
}: {
  title: ReactNode;
  icon?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Deixa o subtítulo quebrar linha em vez de cortar com reticências (ex.: contadores com o painel aberto). */
  subtitleWrap?: boolean;
}) {
  const { openNav } = useShell();
  return (
    <header
      className={cn(
        "flex min-h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:px-5",
        "pt-[env(safe-area-inset-top)]",
        className,
      )}
    >
      <IconButton label="Abrir menu" className="md:hidden" onClick={openNav}>
        <Menu className="size-5" />
      </IconButton>
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <div className="min-w-0 flex-1 py-2">
        <h1 className="truncate text-base leading-tight font-semibold">{title}</h1>
        {subtitle && <div className={cn("text-xs text-muted", subtitleWrap ? "leading-snug" : "truncate")}>{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}
