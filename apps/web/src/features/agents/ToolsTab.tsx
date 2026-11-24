import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Plug, Sparkles } from "lucide-react";
import { BROWSER_TOOL, NATIVE_TOOLS, type AgentDTO, type ConnectorDTO, type NativeTool, type SkillDTO, type ToolLevel } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { canEditAgent, isAdmin } from "../../lib/actors";
import { Badge, ConfirmDialog, InlineError, LockedNote, Spinner, Toggle } from "../../components/ui";
import { useWsId } from "../shell/hooks";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { Segmented, useSaveAgent } from "./shared";
import { TrustRules } from "./TrustRules";

const TRUST_MODES: { id: AgentDTO["trustMode"]; label: string; text: string }[] = [
  { id: "ask", label: "Perguntar quando o pedido não cobre", text: "Se a ação não estiver no que a pessoa pediu nem nas regras, o agente espera a aprovação do responsável." },
  { id: "auto", label: "Agir sem perguntar", text: "O agente cria, muda, envia e apaga sem esperar aprovação. Só as regras “Perguntar antes” e “Proibir” seguram." },
];

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

  const isOwner = agent.ownerUserId === me?.userId;
  const browserOn = agent.toolPerms[BROWSER_TOOL] === "write";
  /** Só o responsável liga; um admin pode desligar. */
  const canToggleBrowser = isOwner || (browserOn && isAdmin(me?.role) && canEdit);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const trustMode = agent.trustMode ?? "ask";

  const toggleBrowser = async (on: boolean) => {
    setPending(BROWSER_TOOL);
    // Só a chave do navegador: o hub junta com o resto e confere cada chave enviada.
    await save({ toolPerms: { [BROWSER_TOOL]: on ? "write" : "none" } }, "");
    setPending(null);
  };

  const setTrustMode = async (mode: AgentDTO["trustMode"]) => {
    setPending("trustMode");
    const ok = await save({ trustMode: mode }, "");
    setPending(null);
    if (ok) setConfirmAuto(false);
  };

  const levelOf = (key: string): ToolLevel => agent.toolPerms[key] ?? "none";
  const change = async (key: string, level: ToolLevel) => {
    setPending(key);
    // Só a chave que mudou: o hub junta com o resto, e mandar tudo faria ele conferir (e recusar)
    // conectores de outras pessoas que este agente já usa.
    await save({ toolPerms: { [key]: level } }, "");
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

      <section aria-labelledby="tools-browser">
        <h3 id="tools-browser" className="mb-2 text-sm font-semibold">
          Navegador
        </h3>
        <div className="rounded-lg border border-line bg-surface px-3 py-2 md:px-4">
          <Toggle
            label="Navegador próprio"
            description={
              <>
                O agente abre e usa sites de verdade quando não existe um conector para o serviço. O navegador roda no computador de quem é responsável pelo
                agente, e o runner desse computador também precisa estar com o navegador ligado (<code className="font-mono break-all">{'"browser": { "enabled": true }'}</code>{" "}
                no config.json). As senhas vêm do Cofre e nunca são mostradas ao agente.
              </>
            }
            checked={browserOn}
            onChange={(v) => void toggleBrowser(v)}
            disabled={!canToggleBrowser || saving}
            disabledReason={
              canToggleBrowser
                ? undefined
                : `Só o responsável (${members[agent.ownerUserId]?.name ?? "outra pessoa"}) liga o navegador, porque ele roda no computador dessa pessoa.`
            }
          />
          {pending === BROWSER_TOOL && <Spinner label="Salvando" />}
          {browserOn && !isOwner && canToggleBrowser && <LockedNote>Como admin, você pode desligar. Só o responsável liga de novo.</LockedNote>}
        </div>
      </section>

      <section aria-labelledby="tools-trust">
        <h3 id="tools-trust" className="mb-1 flex items-center gap-2 text-sm font-semibold">
          Ações em serviços conectados
          {pending === "trustMode" && <Spinner label="Salvando" />}
        </h3>
        <p className="mb-2 text-xs text-muted">
          Ler e consultar sempre funciona. Tudo que cria, muda, envia ou apaga é conferido com o que a pessoa pediu e com as regras abaixo; se não bater, espera a
          aprovação do responsável.
        </p>
        <div role="radiogroup" aria-labelledby="tools-trust" className="divide-y divide-line rounded-lg border border-line bg-surface">
          {TRUST_MODES.map((m) => {
            const on = trustMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!canEdit || saving}
                onClick={() => {
                  if (on) return;
                  if (m.id === "auto") setConfirmAuto(true);
                  else void setTrustMode("ask");
                }}
                className="flex min-h-12 w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-60 md:px-4"
              >
                <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border", on ? "border-primary" : "border-line-strong")} aria-hidden>
                  {on && <span className="size-2.5 rounded-full bg-primary" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                    {m.label}
                    {m.id === "ask" && <Badge tone="primary">recomendado</Badge>}
                  </span>
                  <span className="block text-xs text-muted">{m.text}</span>
                </span>
              </button>
            );
          })}
        </div>
        {!canEdit && <LockedNote>Só o responsável ou um admin muda.</LockedNote>}
      </section>

      <TrustRules agent={agent} connectors={connectors} />

      <ConfirmDialog
        open={confirmAuto}
        onClose={() => setConfirmAuto(false)}
        onConfirm={() => void setTrustMode("auto")}
        loading={pending === "trustMode"}
        danger
        title={`Deixar ${agent.name} agir sem perguntar?`}
        body={
          <>
            {agent.name} vai poder criar, mudar, enviar e apagar coisas nos serviços conectados sem esperar a aprovação de ninguém, mesmo quando o pedido não falava
            disso. Só continuam valendo as regras “Perguntar antes” e “Proibir”. Você pode voltar atrás a qualquer momento.
          </>
        }
        confirmLabel="Agir sem perguntar"
      />
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
