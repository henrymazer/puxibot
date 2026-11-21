import { useCallback, useEffect, useState } from "react";
import type { ActorRef, WikiPageDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { authorshipLabel } from "../../lib/actors";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";

/** Lista plana da wiki (sem corpo). Recarrega quando chega `wiki.changed` ou ao reconectar. */
export function useWikiPages(ws: string, trash = false) {
  const version = useWorkspace((s) => s.wikiVersion);
  const [pages, setPages] = useState<WikiPageDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api
      .listWiki(ws, { trash })
      .then((list) => {
        setPages(list);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [ws, trash]);
  useEffect(reload, [reload, version]);
  return { pages, error, reload };
}

/** "Tito, em nome de Ana" a partir do estado do workspace. */
export function useAuthorship() {
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  return useCallback(
    (actor: ActorRef, onBehalfOfUserId?: string | null) => authorshipLabel({ members, agents }, actor, onBehalfOfUserId),
    [members, agents],
  );
}

export function ActorAvatar({ actor, size = "xs" }: { actor: ActorRef; size?: "xs" | "sm" | "md" }) {
  const agent = useWorkspace((s) => (actor.type === "agent" ? s.agents[actor.id] : undefined));
  const member = useWorkspace((s) => (actor.type === "user" ? s.members[actor.id] : undefined));
  if (actor.type === "agent") return <AgentAvatar agent={agent ?? { id: actor.id, name: "Agente", avatarColor: null, avatarAccessory: null }} size={size} />;
  return <PersonAvatar member={member} name={member?.name ?? "?"} size={size} />;
}
