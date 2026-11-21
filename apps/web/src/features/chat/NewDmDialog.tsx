import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ActorRef } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { errorMessage } from "../../api";
import { InlineError, Modal } from "../../components/ui";
import { paths } from "../../lib/paths";
import { ActorPicker } from "./ActorPicker";

export function NewDmDialog({ onClose, onOpened }: { onClose: () => void; onOpened: () => void }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const openDm = useWorkspace((s) => s.openDm);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (a: ActorRef) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await openDm(a);
      onOpened();
      navigate(paths.channel(ws, ch.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Nova conversa" description="Converse direto com uma pessoa ou um agente." size="sm">
      <div className="flex flex-col gap-3">
        <ActorPicker selected={[]} onToggle={(a) => void pick(a)} multiple={false} includeMe autoFocus />
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
