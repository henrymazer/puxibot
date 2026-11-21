import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { ActorRef } from "@puxibot/shared";
import { useWorkspace } from "../../store/workspace";
import { api, errorMessage } from "../../api";
import { Button, Field, InlineError, Input, Modal, Toggle } from "../../components/ui";
import { paths } from "../../lib/paths";
import { ActorPicker, toggleIn } from "./ActorPicker";

export function slugChannel(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateChannelDialog({ defaultSection, onClose, onCreated }: { defaultSection?: string; onClose: () => void; onCreated: () => void }) {
  const ws = useWorkspace((s) => s.wsId)!;
  const channels = useWorkspace((s) => s.channels);
  const upsertChannel = useWorkspace((s) => s.upsertChannel);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [section, setSection] = useState(defaultSection ?? "");
  const [topic, setTopic] = useState("");
  const [humansOnly, setHumansOnly] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [members, setMembers] = useState<ActorRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sections = useMemo(() => [...new Set(Object.values(channels).map((c) => c.section).filter(Boolean) as string[])].sort(), [channels]);
  const slug = slugChannel(name);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!slug) {
      setError("Dê um nome ao canal.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ch = await api.createChannel(ws, {
        name: slug,
        section: section.trim() || undefined,
        topic: topic.trim() || undefined,
        humansOnly,
        isPrivate,
        members: (humansOnly ? members.filter((m) => m.type === "user") : members).length ? (humansOnly ? members.filter((m) => m.type === "user") : members) : undefined,
      });
      upsertChannel(ch);
      onCreated();
      navigate(paths.channel(ws, ch.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Criar canal"
      description="Canais organizam a conversa por assunto, time ou projeto."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Criar canal
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Nome" hint={slug && slug !== name ? `Vai ficar #${slug}` : "Minúsculas, sem espaços. Ex.: lancamento-site"}>
          {(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} data-autofocus maxLength={60} />}
        </Field>
        <Field label="Seção" hint="Agrupa canais na barra lateral, como Marketing ou Tech. Opcional.">
          {(id, d) => (
            <>
              <Input id={id} aria-describedby={d} list={`${id}-list`} value={section} onChange={(e) => setSection(e.target.value)} maxLength={40} />
              <datalist id={`${id}-list`}>
                {sections.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Assunto" hint="Opcional.">
          {(id, d) => <Input id={id} aria-describedby={d} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} />}
        </Field>
        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
          <Toggle checked={humansOnly} onChange={setHumansOnly} label="Só pessoas" description="Agentes não entram, não leem e não respondem." />
          <Toggle checked={isPrivate} onChange={setIsPrivate} label="Privado" description="Só quem for adicionado vê o canal." />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Quem entra agora {members.length > 0 && <span className="text-muted">({members.length})</span>}</p>
          <ActorPicker selected={members} onToggle={(a) => setMembers((m) => toggleIn(m, a))} includeAgents={!humansOnly} />
        </div>
        <InlineError message={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
