/** Abre "Nova tarefa" de qualquer tela (store leve, fica no pacote inicial). */
import { create } from "zustand";
import type { TaskStatus } from "@puxibot/shared";

// ---------- "Nova tarefa" aberta de qualquer tela (ex.: a partir de uma mensagem) ----------
export interface NewTaskPrefill {
  title?: string;
  description?: string;
  status?: TaskStatus;
  sourceMessageId?: string;
  /** Canal da mensagem de origem, para o link de volta. */
  sourceChannelId?: string;
}

export const useNewTask = create<{ prefill: NewTaskPrefill | null; open: (p?: NewTaskPrefill) => void; close: () => void }>((set) => ({
  prefill: null,
  open: (p = {}) => set({ prefill: p }),
  close: () => set({ prefill: null }),
}));

