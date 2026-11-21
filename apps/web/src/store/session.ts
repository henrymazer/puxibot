import { create } from "zustand";
import type { UserDTO, WorkspaceDTO } from "@puxibot/shared";
import { api, ApiClientError, errorMessage } from "../api";

type Status = "loading" | "anon" | "authed" | "error";

interface SessionState {
  status: Status;
  error: string | null;
  user: UserDTO | null;
  workspaces: WorkspaceDTO[];
  load: () => Promise<void>;
  setSession: (user: UserDTO, workspaces?: WorkspaceDTO[]) => void;
  addWorkspace: (ws: WorkspaceDTO) => void;
  updateWorkspace: (ws: WorkspaceDTO) => void;
  setUser: (user: UserDTO) => void;
  logout: () => Promise<void>;
  clear: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  error: null,
  user: null,
  workspaces: [],
  async load() {
    set({ status: "loading", error: null });
    try {
      const me = await api.me();
      set({ status: "authed", user: me.user, workspaces: me.workspaces });
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) set({ status: "anon", user: null, workspaces: [] });
      else set({ status: "error", error: errorMessage(err) });
    }
  },
  setSession(user, workspaces) {
    set({ status: "authed", user, workspaces: workspaces ?? get().workspaces, error: null });
  },
  addWorkspace(ws) {
    set({ workspaces: [...get().workspaces.filter((w) => w.id !== ws.id), ws] });
  },
  updateWorkspace(ws) {
    set({ workspaces: get().workspaces.map((w) => (w.id === ws.id ? { ...w, ...ws } : w)) });
  },
  setUser(user) {
    set({ user });
  },
  async logout() {
    try {
      await api.logout();
    } finally {
      get().clear();
    }
  },
  clear() {
    set({ status: "anon", user: null, workspaces: [] });
  },
}));

const LAST_WS = "tb-last-ws";
export function rememberWorkspace(id: string): void {
  try {
    localStorage.setItem(LAST_WS, id);
  } catch {
    /* ignore */
  }
}
export function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WS);
  } catch {
    return null;
  }
}
