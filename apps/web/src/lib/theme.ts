import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";
const KEY = "tb-theme";

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export const useTheme = create<{ pref: ThemePref; set: (p: ThemePref) => void }>((set) => ({
  pref: typeof window === "undefined" ? "system" : read(),
  set(pref) {
    try {
      if (pref === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
    apply(pref);
    set({ pref });
  },
}));
