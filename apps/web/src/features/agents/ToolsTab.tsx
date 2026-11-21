import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Plug, Sparkles } from "lucide-react";
import { NATIVE_TOOLS, type AgentDTO, type ConnectorDTO, type NativeTool, type SkillDTO, type ToolLevel } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { canEditAgent } from "../../lib/actors";
import { InlineError, LockedNote, Spinner } from "../../components/ui";
import { useWsId } from "../shell/hooks";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { Segmented, useSaveAgent } from "./shared";

const LEVELS: { id: ToolLevel; label: string }[] = [
  { id: "none", label: "Sem acesso" },
  { id: "read", label: "Ler" },
  { id: "write", label: "Ler e escrever" },
];

const NATIVE: Record<NativeTool, { label: string; text: string }> = {
  messages: { label: "Mensagens", text: "Ler conversas e mandar mensagens em canais e DMs." },
  memory: { label: "Contexto e memória", text: "Consultar e guardar o que deve lembrar." },
  tasks: { label: "Tarefas", text: "Ver, criar e mover tarefas do quadro." },
  wiki: { label: "Wiki", text: "Ler e escrever páginas da wiki do time." },
  drive: { label: "Drive", text: "Abrir e salvar arquivos no drive." },
  agents: { label: "Outros agentes", text: "Ver o time e consultar outros agentes." },
};

export function ToolsTab({ agent }: { agent: AgentDTO }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const members = useWorkspace((s) => s.members);
  const canEdit = canEditAgent(agent, me);
  const { save, saving, error } = useSaveAgent(ws, agent);
  const [pending, setPending] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<ConnectorDTO[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillDTO[] | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSkills(ws)
      .then((l) => setSkills(l.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))))
      .catch((e) => {
        setSkillError(errorMessage(e));
        setSkills([]);
      });
  }, [ws]);

  const toggleSkill = async (id: string) => {
    setPending(`skill:${id}`);
    const next = agent.skillIds.includes(id) ? agent.skillIds.filter((x) => x !== id) : [...agent.skillIds, id];
    await save({ skillIds: next }, "");
    setPending(null);
  };

  useEffect(() => {
    api
      .listConnectors(ws)
      .then(setConnectors)
      .catch((e) => {
        setConnError(errorMessage(e));
        setConnectors([]);
      });
  }, [ws]);

  const levelOf = (key: string): ToolLevel => agent.toolPerms[key] ?? "none";
  const change = async (key: string, level: ToolLevel) => {
    setPending(key);
    await save({ toolPerms: { ...agent.toolPerms, [key]: level } }, "");
    setPending(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <InlineError message={error} />
      {!canEdit && <LockedNote>Só o responsável ou um admin muda o acesso às ferramentas.</LockedNote>}

      <section aria-labelledby="tools-native">
        <h3 id="tools-native" className="mb-2 text-sm font-semibold">
          Ferramentas do Puxibot
        </h3>
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {NATIVE_TOOLS.map((t) => (
            <ToolRow
              key={t}
              label={NATIVE[t].label}
              text={NATIVE[t].text}
              value={levelOf(t)}
              onChange={(v) => void change(t, v)}
              disabled={!canEdit || (saving && pending !== t)}
              busy={pending === t}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="tools-skills">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 id="tools-skills" className="text-sm font-semibold">
            Skills
          </h3>
          <Link to={paths.settings(ws, "skills")} className="text-xs text-primary-text hover:underline">
            Gerenciar skills
          </Link>
        </div>
        {skills === null ? (
          <Spinner />
        ) : skills.length === 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-sm text-muted">
            <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Nenhuma skill no workspace ainda. Skills são instruções reutilizáveis, como “como revisar um PR”.
              {skillError && <span className="block text-xs text-subtle">({skillError})</span>}
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface" aria-label="Skills que este agente usa">
            {skills.map((sk) => {
              const on = agent.skillIds.includes(sk.id);
              const busy = pending === `skill:${sk.id}`;
              return (
                <li key={sk.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={!canEdit || (saving && !busy)}
                    onClick={() => void toggleSkill(sk.id)}
                    className="flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-60 md:px-4"
                  >
                    <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-xs border", on ? "border-primary bg-primary text-primary-fg" : "border-line-strong")} aria-hidden>
                      {on && <Check className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{sk.name}</span>
                      {sk.description && <span className="block text-xs text-muted">{sk.description}</span>}
                    </span>
                    {busy && <Spinner label="Salvando" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="tools-connectors">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 id="tools-connectors" className="text-sm font-semibold">
            Conectores
          </h3>
          <Link to={paths.settings(ws, "conectores")} className="text-xs text-primary-text hover:underline">
            Gerenciar conectores
          </Link>
        </div>
        <p className="mb-2 text-xs text-muted">
          Um conector só funciona quando o agente roda no computador de quem conectou. Se o pedido for executado no computador de outra pessoa, o agente
          trabalha sem esse conector.
        </p>
        {connectors === null ? (
          <Spinner />
        ) : connectors.length === 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-sm text-muted">
            <Plug className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Nenhum conector no workspace ainda.
              {connError && <span className="block text-xs text-subtle">({connError})</span>}
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {connectors.map((c) => {
              const key = `connector:${c.id}`;
              const mine = c.ownerUserId === me?.userId;
              const ownerName = members[c.ownerUserId]?.name ?? "outra pessoa";
              return (
                <ToolRow
                  key={c.id}
                  label={c.name}
                  text={mine ? "Conectado por você. Funciona quando o agente roda no seu computador." : `Conectado por ${ownerName}. Funciona quando o agente roda no computador de ${ownerName.split(" ")[0]}.`}
                  value={levelOf(key)}
                  onChange={(v) => void change(key, v)}
                  disabled={!canEdit || !mine || (saving && pending !== key)}
                  busy={pending === key}
                  locked={!mine ? `Só quem conectou (${ownerName}) concede acesso.` : undefined}
                />
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function ToolRow({
  label,
  text,
  value,
  onChange,
  disabled,
  busy,
  locked,
}: {
  label: string;
  text: string;
  value: ToolLevel;
  onChange: (v: ToolLevel) => void;
  disabled?: boolean;
  busy?: boolean;
  locked?: string;
}) {
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center md:px-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {label}
          {busy && <Spinner label="Salvando" />}
        </div>
        <p className="text-xs text-muted">{text}</p>
        {locked && <LockedNote>{locked}</LockedNote>}
      </div>
      <Segmented label={`Acesso a ${label}`} value={value} options={LEVELS} onChange={onChange} disabled={disabled} />
    </li>
  );
}
