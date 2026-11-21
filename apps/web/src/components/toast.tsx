import { create } from "zustand";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { cn } from "../lib/cn";
import { errorMessage } from "../api";

interface Toast {
  id: number;
  tone: "error" | "success" | "info";
  text: string;
}
let n = 0;
export const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, "id">) => void; dismiss: (id: number) => void }>(
  (set, get) => ({
    toasts: [],
    push(t) {
      const id = ++n;
      set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
      setTimeout(() => get().dismiss(id), t.tone === "error" ? 7000 : 3500);
    },
    dismiss(id) {
      set({ toasts: get().toasts.filter((x) => x.id !== id) });
    },
  }),
);

export const toast = {
  error: (err: unknown) => useToasts.getState().push({ tone: "error", text: errorMessage(err) }),
  success: (text: string) => useToasts.getState().push({ tone: "success", text }),
  info: (text: string) => useToasts.getState().push({ tone: "info", text }),
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:items-end"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={cn(
            "tb-anim-pop pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border bg-elevated px-3 py-2.5 text-sm shadow-pop",
            t.tone === "error" ? "border-danger/40" : "border-line",
          )}
        >
          {t.tone === "error" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          <span className="flex-1">{t.text}</span>
          <button aria-label="Fechar aviso" className="text-muted hover:text-ink" onClick={() => dismiss(t.id)}>
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
