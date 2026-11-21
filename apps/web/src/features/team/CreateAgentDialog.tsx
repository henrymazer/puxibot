import { useState } from "react";
import { handleSchema } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { AGENT_ACCESSORIES, AVATAR_COLORS, AgentAvatar } from "../../components/Avatar";
import { Button, Field, InlineError, Input, Modal, Select, Textarea } from "../../components/ui";
import { toast } from "../../components/toast";
import { cn } from "../../lib/cn";
import { useAgentProfile, useWsId } from "../shell/hooks";

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
}

export function AvatarPicker({
  id,
  name,
  color,
  accessory,
  onColor,
  onAccessory,
  disabled,
}: {
  id: string;
  name: string;
  color: string;
  accessory: string;
  onColor: (c: string) => void;
  onAccessory: (a: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <AgentAvatar agent={{ id, name: name || "Agente", avatarColor: color, avatarAccessory: accessory || null }} size="xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <fieldset disabled={disabled}>
          <legend className="mb-1.5 text-sm font-medium">Cor</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cor do avatar">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={`Cor ${c}`}
                onClick={() => onColor(c)}
                className={cn(
                  "size-8 rounded-md border-2 max-md:size-10",
                  color === c ? "border-ink" : "border-transparent",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend className="mb-1.5 text-sm font-medium">Acessório</legend>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Acessório do avatar">
            {AGENT_ACCESSORIES.map((a) => (
              <button
                key={a.id || "none"}
                type="button"
                role="radio"
                aria-checked={accessory === a.id}
                onClick={() => onAccessory(a.id)}
                className={cn(
                  "h-8 rounded-md border px-2.5 text-xs max-md:h-10",
                  accessory === a.id ? "border-primary bg-primary-soft text-primary-text" : "border-line text-muted hover:bg-surface-2",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  );
}

export function CreateAgentDialog({ onClose }: { onClose: () => void }) {
  const ws = useWsId();
  const sectors = useWorkspace((s) => s.sectors);
  const upsertAgent = useWorkspace((s) => s.upsertAgent);
  const profile = useAgentProfile();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [sectorId, setSectorId] = useState("");
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [accessory, setAccessory] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveHandle = handleTouched ? handle : slugify(name);
  const handleCheck = handleSchema.safeParse(effectiveHandle);
  const handleError = effectiveHandle && !handleCheck.success ? (handleCheck.error.issues[0]?.message ?? "Handle inválido") : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Dê um nome ao agente.");
    if (!handleCheck.success) return setError("Escolha um @ válido: 2 a 32 caracteres, minúsculas, números, - ou _.");
    setSaving(true);
    setError(null);
    try {
      const agent = await api.createAgent(ws, {
        name: name.trim(),
        handle: effectiveHandle,
        role: role.trim() || undefined,
        description: description.trim() || undefined,
        sectorId: sectorId || undefined,
        avatarColor: color,
        avatarAccessory: accessory || undefined,
      });
      upsertAgent(agent);
      toast.success(`${agent.name} entrou no time.`);
      onClose();
      profile.open(agent.id, "instrucoes");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Criar agente"
      description="Você vira o responsável. Depois dá para ajustar instruções, acesso e orçamento."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="create-agent" loading={saving}>
            Criar agente
          </Button>
        </>
      }
    >
      <form id="create-agent" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome">
            {(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} data-autofocus placeholder="Ex.: Tito" maxLength={60} />}
          </Field>
          <Field label="@ para mencionar" hint="Minúsculas, números, - ou _." error={handleError}>
            {(id, d) => (
              <div className="flex items-center">
                <span className="mr-1 text-muted">@</span>
                <Input
                  id={id}
                  aria-describedby={d}
                  value={effectiveHandle}
                  onChange={(e) => {
                    setHandleTouched(true);
                    setHandle(e.target.value.toLowerCase());
                  }}
                  placeholder="tito"
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
        <AvatarPicker id={effectiveHandle || "novo"} name={name} color={color} accessory={accessory} onColor={setColor} onAccessory={setAccessory} />
        <InlineError message={error} />
      </form>
    </Modal>
  );
}
