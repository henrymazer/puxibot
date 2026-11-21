import type { ReactNode } from "react";

export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--tb-primary)" />
      <circle cx="12" cy="16" r="4.5" fill="var(--tb-bg)" />
      <rect x="17.5" y="11.5" width="9" height="9" rx="2.5" fill="#e9b872" />
    </svg>
  );
}

/** Moldura das telas de conta: coluna central calma, sem distrações. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-bg px-4 pt-[max(3rem,env(safe-area-inset-top))] pb-10 md:justify-center md:pt-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <BrandMark />
          <span className="text-lg font-semibold tracking-tight">Puxibot</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 text-sm text-muted">{footer}</div>}
      </div>
    </div>
  );
}
