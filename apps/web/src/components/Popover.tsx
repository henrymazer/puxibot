import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

/**
 * Menu/painel flutuante. No desktop fica preso ao gatilho; no celular vira folha no rodapé.
 * O conteúdo é renderizado num portal para não ser cortado por áreas com rolagem.
 */
export function Popover({
  open,
  onClose,
  anchor,
  children,
  align = "start",
  side = "bottom",
  className,
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus],button,a,input,textarea");
    first?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        prev?.focus?.();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor]);

  if (!open) return null;
  const rect = anchor.current?.getBoundingClientRect();
  const isMobile = window.matchMedia("(max-width: 767px)").matches;
  const style: React.CSSProperties = {};
  if (!isMobile && rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (side === "bottom") style.top = Math.min(rect.bottom + 6, vh - 80);
    else style.bottom = vh - rect.top + 6;
    if (align === "start") style.left = Math.max(8, Math.min(rect.left, vw - 330));
    else style.right = Math.max(8, vw - rect.right);
  }
  return createPortal(
    <>
      {isMobile && <div className="tb-anim-fade fixed inset-0 z-50 bg-[var(--tb-overlay)]" aria-hidden />}
      <div
        ref={ref}
        role="dialog"
        aria-label={label}
        style={style}
        className={cn(
          "tb-anim-pop fixed z-50 border border-line bg-elevated shadow-pop",
          isMobile
            ? "inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-xl pb-[env(safe-area-inset-bottom)]"
            : "max-h-[70vh] overflow-y-auto rounded-lg",
          className,
        )}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
  trailing,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-50 max-md:min-h-12",
        danger ? "text-danger" : "text-ink",
      )}
    >
      {icon && <span className={cn("shrink-0", danger ? "text-danger" : "text-muted")}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}
