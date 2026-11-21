/** Rotas da interface (também usadas para montar links vindos do hub, como notificações). */
export const paths = {
  login: "/entrar",
  signup: "/cadastro",
  invite: (code: string) => `/convite/${code}`,
  newWorkspace: "/novo-workspace",
  workspace: (ws: string) => `/w/${ws}`,
  channel: (ws: string, id: string) => `/w/${ws}/c/${id}`,
  thread: (ws: string, channelId: string, rootId: string) => `/w/${ws}/c/${channelId}?thread=${rootId}`,
  team: (ws: string) => `/w/${ws}/equipe`,
  approvals: (ws: string) => `/w/${ws}/aprovacoes`,
  settings: (ws: string, section = "perfil") => `/w/${ws}/config/${section}`,
  pair: (ws: string, code?: string) => `/w/${ws}/parear${code ? `?code=${encodeURIComponent(code)}` : ""}`,
  area: (ws: string, area: string) => `/w/${ws}/${area}`,
  tasks: (ws: string, taskId?: string) => `/w/${ws}/tarefas${taskId ? `?tarefa=${encodeURIComponent(taskId)}` : ""}`,
  wiki: (ws: string, pageId?: string) => `/w/${ws}/wiki${pageId ? `/${pageId}` : ""}`,
  drive: (ws: string) => `/w/${ws}/drive`,
  routines: (ws: string) => `/w/${ws}/rotinas`,
  onboarding: (ws: string) => `/w/${ws}/boas-vindas`,
};

/** Links de notificação: aceita caminho completo ("/w/..."), relativo ao workspace ("/c/...") ou URL absoluta. */
export function resolveLink(ws: string, link: string | null): string | null {
  if (!link) return null;
  try {
    if (/^https?:\/\//.test(link)) {
      const u = new URL(link);
      if (u.origin !== location.origin) return null;
      link = u.pathname + u.search;
    }
  } catch {
    return null;
  }
  if (link.startsWith("/w/")) return link;
  return `/w/${ws}${link.startsWith("/") ? "" : "/"}${link}`;
}
