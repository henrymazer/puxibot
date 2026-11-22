import { useState } from "react";
import { handleSchema, type AgentDTO } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { AVATAR_COLORS } from "../../components/Avatar";
import { Button, Field, InlineError, Input, Modal, Select, Textarea } from "../../components/ui";
import { AvatarPicker } from "../team/CreateAgentDialog";
import { useWsId } from "../shell/hooks";
import { useSaveAgent } from "./shared";
import { agentProfilePatch } from "./profilePatch";

export function EditAgentDialog({ agent, onClose }: { agent: AgentDTO; onClose: () => void }) {
  const ws = useWsId();
  const sectors = useWorkspace((s) => s.sectors);
  const [name, setName] = useState(agent.name);
  const [handle, setHandle] = useState(agent.handle);
  const [role, setRole] = useState(agent.role ?? "");
  const [description, setDescription] = useState(agent.description ?? "");
  const [sectorId, setSectorId] = useState(agent.sectorId ?? "");
  const [color, setColor] = useState(agent.avatarColor ?? AVATAR_COLORS[0]!);
  const [accessory, setAccessory] = useState(agent.avatarAccessory ?? "");
  const { save, saving, error, setError } = useSaveAgent(ws, agent);

  const handleCheck = handleSchema.safeParse(handle);
  const handleError = handle && !handleCheck.success ? (handleCheck.error.issues[0]?.message ?? "Handle inválido") : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Dê um nome ao agente.");
    if (!handleCheck.success) return setError("Escolha um @ válido: 2 a 32 caracteres, minúsculas, números, - ou _.");
    const patch = agentProfilePatch(agent, { name, handle, role, description, sectorId, avatarColor: color, avatarAccessory: accessory });
    if (Object.keys(patch).length === 0) return onClose();
    if (await save(patch, "Perfil salvo.")) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Editar ${agent.name}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="edit-agent" loading={saving}>
            Salvar
          </Button>
        </>
      }
    >
      <form id="edit-agent" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome">
            {(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} data-autofocus maxLength={60} />}
          </Field>
          <Field label="@ para mencionar" hint="Se mudar, as mensagens antigas continuam mostrando o @ anterior." error={handleError}>
            {(id, d) => (
              <div className="flex items-center">
                <span className="mr-1 text-muted">@</span>
                <Input
                  id={id}
                  aria-describedby={d}
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.toLowerCase())}
                  maxLength={32}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              </div>
            )}
          </Field>
          <Field label="Função" hint="Ex.: Engenharia, Marketing, Finanças.">
            {(id, d) => <Input id={id} aria-describedby={d} value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} />}
          </Field>
          <Field label="Setor">
            {(id) => (
              <Select id={id} value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
                <option value="">Sem setor</option>
                {Object.values(sectors).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="O que ele faz" hint="Aparece no perfil e ajuda o time a saber quando chamar.">
          {(id, d) => <Textarea id={id} aria-describedby={d} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="min-h-20" />}
        </Field>
        <AvatarPicker id={agent.id} name={name} color={color} accessory={accessory} onColor={setColor} onAccessory={setAccessory} />
        <InlineError message={error} />
      </form>
    </Modal>
  );
}
