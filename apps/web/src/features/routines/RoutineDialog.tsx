import { useEffect, useMemo, useState } from "react";
import type { RoutineDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { Button, Field, InlineError, Input, Modal, Select, Textarea, Toggle } from "../../components/ui";
import { toast } from "../../components/toast";
import { canEditAgent, channelLabel } from "../../lib/actors";
import { commonTimezones } from "../../lib/cron";
import { ScheduleBuilder } from "./ScheduleBuilder";
import { routineChannelsFor } from "./routineChannels";

export function RoutineDialog({
  routine,
  agentId,
  onClose,
  onSaved,
}: {
  routine?: RoutineDTO;
  /** Fixa o agente (aba Rotinas do perfil). */
  agentId?: string;
  onClose: () => void;
  onSaved: (r: RoutineDTO) => void;
}) {
  const ws = useWorkspace((s) => s.wsId)!;
  const agents = useWorkspace((s) => s.agents);
  const channels = useWorkspace((s) => s.channels);
  const members = useWorkspace((s) => s.members);
  const myUserId = useWorkspace((s) => s.myUserId);
  const me = useWorkspace((s) => s.me);
  const manageable = useMemo(
    () => Object.values(agents).filter((a) => canEditAgent(a, me)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [agents, me],
  );
  const [agent, setAgent] = useState(routine?.agentId ?? agentId ?? manageable[0]?.id ?? "");
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [cron, setCron] = useState(routine?.cron ?? "0 9 * * 1-5");
  const [cronValid, setCronValid] = useState(true);
  const tzs = useMemo(() => {
    const list = commonTimezones();
    return routine?.timezone && !list.includes(routine.timezone) ? [routine.timezone, ...list] : list;
  }, [routine?.timezone]);
  const [timezone, setTimezone] = useState(routine?.timezone ?? tzs[0]!);
  const [channelId, setChannelId] = useState<string>(routine?.channelId ?? "");
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSummary = routine?.kind === "daily_summary";

  const channelOptions = useMemo(() => {
    const list = routineChannelsFor(Object.values(channels), agent);
    const label = (id: string) => channelLabel({ members, agents, myUserId }, channels[id]!);
    return {
      channels: list.filter((c) => c.kind === "channel").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "pt-BR")),
      dms: list.filter((c) => c.kind === "dm"),
      label,
    };
  }, [channels, members, agents, myUserId, agent]);

  // Trocar de agente pode tirar o canal escolhido da lista: volta para "Sem canal".
  useEffect(() => {
    if (channelId && !channelOptions.channels.some((c) => c.id === channelId) && !channelOptions.dms.some((c) => c.id === channelId)) setChannelId("");
  }, [channelOptions, channelId]);

  const submit = async () => {
    if (!agent) return setError("Escolha o agente.");
    if (!name.trim()) return setError("Dê um nome à rotina.");
    if (!cronValid) return setError("Confira o horário.");
    if (!prompt.trim() && !isSummary) return setError("Diga o que o agente deve fazer.");
    setBusy(true);
    setError(null);
    try {
      const input = { agentId: agent, name: name.trim(), prompt, cron, timezone, channelId: channelId || null, enabled };
      const saved = routine ? await api.updateRoutine(ws, routine.id, input) : await api.createRoutine(ws, input);
      onSaved(saved && saved.id ? saved : { ...(routine as RoutineDTO), ...input });
      toast.success(routine ? "Rotina salva." : "Rotina criada.");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={routine ? "Editar rotina" : "Nova rotina"}
      description="O agente faz isso sozinho no horário marcado, no computador do responsável por ele."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()} disabled={!cronValid}>
            {routine ? "Salvar" : "Criar rotina"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Agente">
            {(id) => (
              <Select id={id} value={agent} onChange={(e) => setAgent(e.target.value)} disabled={!!routine || !!agentId}>
                {manageable.length === 0 && <option value="">Nenhum agente que você possa mudar</option>}
                {(routine || agentId) && agents[agent] && !manageable.some((a) => a.id === agent) && <option value={agent}>{agents[agent]!.name}</option>}
                {manageable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} (@{a.handle})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Nome">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Ex.: Resumo de PRs e issues" data-autofocus />}
          </Field>
        </div>
        <Field label="O que fazer" hint="Escreva como se fosse um pedido no chat.">
          {(id, d) => (
            <Textarea
              id={id}
              aria-describedby={d}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={20_000}
              placeholder="Ex.: Liste os PRs abertos e as issues novas desde ontem, com o que precisa de revisão."
            />
          )}
        </Field>
        <ScheduleBuilder
          cron={cron}
          timezone={timezone}
          onChange={(c, ok) => {
            setCron(c);
            setCronValid(ok);
          }}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fuso horário">
            {(id) => (
              <Select id={id} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {tzs.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Onde responder" hint="Só aparecem canais que o agente pode usar: abertos, ou privados e conversas de que ele é membro. Sem canal, o resultado fica só na atividade do agente.">
            {(id, d) => (
              <Select id={id} aria-describedby={d} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="">Sem canal</option>
                <optgroup label="Canais">
                  {channelOptions.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </optgroup>
                {channelOptions.dms.length > 0 && (
                  <optgroup label="Conversas diretas">
                    {channelOptions.dms.map((c) => (
                      <option key={c.id} value={c.id}>
                        {channelOptions.label(c.id)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            )}
          </Field>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label="Ligada" description="Desligada, a rotina não roda sozinha, mas você ainda pode executar agora." />
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
