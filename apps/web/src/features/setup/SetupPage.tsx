/**
 * Agente criador: de um lado a conversa, do outro o plano que ele propõe. A pessoa revisa, tira o que
 * não quer, cria tudo com um clique e depois faz as conexões que os agentes precisam, guiada pela tela.
 * O agente nunca cria nada: quem cria é o hub, quando a pessoa clica.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarClock, CheckCircle2, Hash, Lightbulb, Pencil, Plug, Sparkles, Wand2, X } from "lucide-react";
import { catalogApp, type CatalogApp, type ConnectorDTO, type SetupApplyResult, type SetupPlan, type SetupPlanDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { describeCron } from "../../lib/cron";
import { Badge, Button, Card, ConfirmDialog, ErrorState, Field, IconButton, InlineError, Input, LoadingState, Modal, Textarea } from "../../components/ui";
import { toast } from "../../components/toast";
import { PageHeader } from "../shell/PageHeader";
import { useWsId } from "../shell/hooks";
import { MessageList } from "../chat/MessageList";
import { Composer, composerKey } from "../chat/Composer";
import { PendingJobs, usePendingJobs } from "../chat/PendingJobs";
import { CatalogConnectDialog, startConnectorLogin, useCatalog } from "../settings/CatalogConnect";
import { editPlanAgent, planHasContent, planSummary, removeFromPlan, type PlanSection } from "./setupModel";

export function SetupPage() {
  const ws = useWsId();
  const [params] = useSearchParams();
  const fromGuide = params.get("guia") === "1";
  const [channelId, setChannelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "plan">("chat");
  const plan = useWorkspace((s) => s.setupPlan);
  const myUserId = useWorkspace((s) => s.myUserId);
  const runners = useWorkspace((s) => s.runners);
  const online = Object.values(runners).some((r) => r.userId === myUserId && r.online);

  const open = useMemo(
    () => async () => {
      setError(null);
      try {
        const session = await api.openSetupSession(ws);
        const st = useWorkspace.getState();
        // O agente criador e a conversa com ele podem ainda não estar na memória da tela.
        if (!st.agents[session.agentId]) st.upsertAgent(await api.getAgent(ws, session.agentId));
        const channel = await st.openDm({ type: "agent", id: session.agentId });
        useWorkspace.setState({ setupPlan: session.plan });
        setChannelId(channel.id);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [ws],
  );
  useEffect(() => {
    void open();
  }, [open]);

  // Um plano novo chegou enquanto a pessoa olhava a conversa no celular: avisa.
  const draftId = plan?.status === "draft" ? `${plan.id}:${plan.updatedAt}` : null;
  // O rascunho que já existia ao abrir a tela não é novidade: só avisa do que chegar depois.
  const seenDraft = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!channelId) return;
    const first = seenDraft.current === undefined;
    const changed = seenDraft.current !== draftId;
    seenDraft.current = draftId;
    if (!first && changed && draftId && view === "chat" && window.matchMedia("(max-width: 1023px)").matches) {
      toast.success("O criador propôs um plano. Toque em “Plano” para revisar.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, channelId]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title="Montar com o criador"
        icon={<Wand2 className="size-5" />}
        subtitle="Conte como você trabalha; ele propõe o time e você decide o que criar"
        actions={
          <div role="tablist" aria-label="O que mostrar" className="inline-flex rounded-md border border-line bg-surface-2 p-0.5 lg:hidden">
            {(["chat", "plan"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn("h-9 rounded-sm px-3 text-xs font-medium", view === v ? "bg-elevated text-ink shadow-soft" : "text-muted")}
              >
                {v === "chat" ? "Conversa" : "Plano"}
                {v === "plan" && plan?.status === "draft" && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-primary align-middle" aria-label="plano novo" />}
              </button>
            ))}
          </div>
        }
      />
      {error ? (
        <ErrorState message={error} onRetry={() => void open()} className="mt-16" />
      ) : !channelId ? (
        <LoadingState label="Chamando o criador…" className="flex-1" />
      ) : (
        <div className="flex min-h-0 flex-1">
          <section className={cn("flex min-w-0 flex-1 flex-col bg-bg", view !== "chat" && "max-lg:hidden")} aria-label="Conversa com o criador">
            <SetupChat channelId={channelId} online={online} />
          </section>
          <aside
            className={cn("tb-scroll min-w-0 overflow-y-auto border-line bg-surface lg:w-[26rem] lg:shrink-0 lg:border-l xl:w-[30rem]", view !== "plan" && "max-lg:hidden", view === "plan" && "max-lg:flex-1")}
            aria-label="Plano proposto"
          >
            <PlanPanel plan={plan} fromGuide={fromGuide} onBackToChat={() => setView("chat")} />
          </aside>
        </div>
      )}
    </div>
  );
}

function SetupChat({ channelId, online }: { channelId: string; online: boolean }) {
  const ws = useWsId();
  const channel = useWorkspace((s) => s.channels[channelId]);
  const list = useWorkspace((s) => s.messages[channelId]);
  const [error, setError] = useState<string | null>(null);
  const pending = usePendingJobs(channelId, null);
  const footerKey = pending.map((p) => `${p.jobId}:${p.job?.status}:${p.stream?.text.length ?? 0}`).join("|");

  useEffect(() => {
    const st = useWorkspace.getState();
    st.setActiveChannel(channelId);
    st.loadChannel(channelId).catch((e) => setError(errorMessage(e)));
    void st.loadChannelJobs(channelId);
    return () => useWorkspace.getState().setActiveChannel(null);
  }, [channelId]);

  if (!channel) return <LoadingState className="flex-1" />;
  return (
    <>
      {!online && (
        <p className="border-b border-line bg-warning-soft px-4 py-2 text-sm text-warning" role="status">
          Seu computador não está ligado: o criador responde assim que ele ligar.{" "}
          <Link to={paths.settings(ws, "computadores")} className="font-medium underline">
            Ligar o computador
          </Link>
        </p>
      )}
      {error ? (
        <ErrorState message={error} onRetry={() => void useWorkspace.getState().loadChannel(channelId, true).then(() => setError(null)).catch((e) => setError(errorMessage(e)))} />
      ) : !list?.loaded ? (
        <LoadingState label="Carregando a conversa…" className="flex-1" />
      ) : (
        <MessageList
          scrollKey={channelId}
          messages={list.items}
          hasMore={list.hasMore}
          onLoadOlder={() => useWorkspace.getState().loadOlder(channelId)}
          composerKey={composerKey(channelId)}
          header={<ChatIntro empty={list.items.length === 0} />}
          footer={<PendingJobs items={pending} />}
          footerKey={footerKey}
        />
      )}
      <Composer channel={channel} autoFocus placeholder="Conte como o seu trabalho funciona hoje e o que você quer dos agentes" />
    </>
  );
}

function ChatIntro({ empty }: { empty: boolean }) {
  if (!empty) return null;
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <div className="flex items-center gap-2 text-agent">
        <Sparkles className="size-5" aria-hidden />
        <h2 className="text-lg font-semibold text-ink">Como funciona</h2>
      </div>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>Você conta o que o time faz, quem cuida de quê e que ferramentas usa.</li>
        <li>O criador faz poucas perguntas e propõe canais, agentes, rotinas e conexões.</li>
        <li>Você revisa o plano ao lado, tira o que não quiser e clica em criar.</li>
        <li>Por fim, a tela guia a conexão de cada ferramenta externa. Senhas e tokens nunca passam pela conversa.</li>
      </ol>
      <p className="mt-4 flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
        <Lightbulb className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Exemplo: “Somos uma agência de três pessoas. Eu cuido do atendimento, a Ana dos anúncios da Meta e o Caio dos textos. Quero ajuda com o relatório semanal de campanhas e com os
          pedidos que chegam dos clientes.”
        </span>
      </p>
    </div>
  );
}

// ---------- Plano ----------
function PlanPanel({ plan, fromGuide, onBackToChat }: { plan: SetupPlanDTO | null; fromGuide: boolean; onBackToChat: () => void }) {
  const ws = useWsId();
  const [busy, setBusy] = useState<"apply" | "discard" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);

  if (!plan || (plan.status === "applied" && dismissedResult === plan.id)) {
    return (
      <div className="px-5 py-8">
        <h2 className="text-base font-semibold">O plano aparece aqui</h2>
        <p className="mt-2 text-sm text-muted">Quando o criador tiver o suficiente, ele propõe a estrutura e ela aparece nesta coluna para você revisar. Nada é criado antes de você clicar.</p>
      </div>
    );
  }

  if (plan.status === "applied" && plan.result) {
    return <ResultPanel plan={plan} result={plan.result} fromGuide={fromGuide} onMore={() => (setDismissedResult(plan.id), onBackToChat())} />;
  }

  const p = plan.plan;
  const save = async (next: SetupPlan) => {
    setBusy("save");
    setError(null);
    try {
      useWorkspace.setState({ setupPlan: await api.updateSetupPlan(ws, plan.id, next) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = (section: PlanSection, index: number) => void save(removeFromPlan(p, section, index));
  const apply = async () => {
    setBusy("apply");
    setError(null);
    try {
      const applied = await api.applySetupPlan(ws, plan.id);
      useWorkspace.setState({ setupPlan: applied });
      // Agentes e canais novos chegam pelo tempo real; a recarga garante a lista completa.
      void useWorkspace.getState().resync();
      toast.success("Estrutura criada.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const discard = async () => {
    setBusy("discard");
    try {
      await api.discardSetupPlan(ws, plan.id);
      useWorkspace.setState({ setupPlan: null });
      setDiscarding(false);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const locked = busy !== null;
  const canCreate = planHasContent(p);

  return (
    <div className="flex flex-col gap-4 px-4 py-5 md:px-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Plano proposto</h2>
          <Badge tone="primary">rascunho</Badge>
        </div>
        <p className="mt-1 text-sm text-ink">{p.summary}</p>
        <p className="mt-1 text-xs text-muted">Vai criar {planSummary(p)}. O que já existir com o mesmo nome é mantido como está.</p>
      </div>

      <PlanList title="Agentes" empty="Nenhum agente no plano.">
        {p.agents.map((a, i) => (
          <PlanItem
            key={a.handle}
            title={
              <>
                {a.name} <span className="font-normal text-muted">@{a.handle}</span>
              </>
            }
            subtitle={a.role}
            onRemove={() => remove("agents", i)}
            onEdit={() => setEditing(i)}
            disabled={locked}
            removeLabel={`Tirar ${a.name} do plano`}
          >
            <p className="line-clamp-3 text-sm whitespace-pre-line text-muted">{a.instructions}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {a.channels.map((c) => (
                <Badge key={c}>
                  <Hash className="size-3" aria-hidden />
                  {c}
                </Badge>
              ))}
              {a.connectors.map((c) => (
                <Badge key={c} tone="agent">
                  <Plug className="size-3" aria-hidden />
                  {catalogApp(c)?.displayName ?? c}
                </Badge>
              ))}
              {a.skills.map((s) => (
                <Badge key={s} tone="primary">
                  {s}
                </Badge>
              ))}
            </div>
          </PlanItem>
        ))}
      </PlanList>

      {p.channels.length > 0 && (
        <PlanList title="Canais">
          {p.channels.map((c, i) => (
            <PlanItem key={c.name} title={`#${c.name}`} subtitle={c.section} onRemove={() => remove("channels", i)} disabled={locked} removeLabel={`Tirar #${c.name} do plano`}>
              {c.topic && <p className="text-sm text-muted">{c.topic}</p>}
            </PlanItem>
          ))}
        </PlanList>
      )}

      {p.routines.length > 0 && (
        <PlanList title="Rotinas">
          {p.routines.map((r, i) => (
            <PlanItem
              key={`${r.agent}:${r.name}`}
              title={r.name}
              subtitle={`@${r.agent}${r.channel ? ` · publica em #${r.channel}` : ""}`}
              onRemove={() => remove("routines", i)}
              disabled={locked}
              removeLabel={`Tirar a rotina ${r.name} do plano`}
            >
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <CalendarClock className="size-3.5" aria-hidden />
                {describeCron(r.cron) ?? r.cron}
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{r.prompt}</p>
            </PlanItem>
          ))}
        </PlanList>
      )}

      {p.skills.length > 0 && (
        <PlanList title="Skills">
          {p.skills.map((s, i) => (
            <PlanItem key={s.name} title={s.name} subtitle={s.description} onRemove={() => remove("skills", i)} disabled={locked} removeLabel={`Tirar a skill ${s.name} do plano`}>
              <p className="line-clamp-3 text-sm whitespace-pre-line text-muted">{s.body}</p>
            </PlanItem>
          ))}
        </PlanList>
      )}

      {p.wikiPages.length > 0 && (
        <PlanList title="Páginas da wiki">
          {p.wikiPages.map((w, i) => (
            <PlanItem key={w.title} title={w.title} onRemove={() => remove("wikiPages", i)} disabled={locked} removeLabel={`Tirar a página ${w.title} do plano`}>
              <p className="line-clamp-3 text-sm whitespace-pre-line text-muted">{w.body}</p>
            </PlanItem>
          ))}
        </PlanList>
      )}

      {p.memories.length > 0 && (
        <PlanList title="Memória do time">
          {p.memories.map((m, i) => (
            <PlanItem key={m} title={m} plain onRemove={() => remove("memories", i)} disabled={locked} removeLabel="Tirar esta memória do plano" />
          ))}
        </PlanList>
      )}

      {p.connectors.length > 0 && (
        <PlanList title="Conexões que os agentes vão precisar">
          {p.connectors.map((c, i) => (
            <PlanItem
              key={c.catalogId ?? c.name}
              title={catalogApp(c.catalogId)?.displayName ?? c.name}
              subtitle={c.catalogId ? "conexão pronta no catálogo" : "você informa o endereço depois"}
              onRemove={() => remove("connectors", i)}
              disabled={locked}
              removeLabel={`Tirar a conexão ${c.name} do plano`}
            >
              <p className="text-sm text-muted">{c.reason}</p>
            </PlanItem>
          ))}
          <li className="text-xs text-muted">As conexões são feitas depois de criar, uma a uma, com a tela guiando. Nada é conectado sozinho.</li>
        </PlanList>
      )}

      <InlineError message={error} />
      {!canCreate && <p className="text-sm text-muted">O plano ficou vazio. Peça ao criador uma nova proposta ou descarte este rascunho.</p>}
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-4 py-3 md:-mx-5 md:px-5">
        <Button variant="ghost" disabled={locked} onClick={() => setDiscarding(true)}>
          Descartar
        </Button>
        <Button variant="primary" loading={busy === "apply"} disabled={locked || !canCreate} onClick={() => void apply()}>
          Criar tudo
        </Button>
      </div>

      {editing !== null && p.agents[editing] && (
        <EditAgentDialog
          agent={p.agents[editing]}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            const idx = editing;
            setEditing(null);
            void save(editPlanAgent(p, idx, patch));
          }}
        />
      )}
      <ConfirmDialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        onConfirm={() => void discard()}
        loading={busy === "discard"}
        title="Descartar este plano?"
        body="Nada foi criado ainda. A conversa continua e você pode pedir outra proposta."
        confirmLabel="Descartar"
      />
    </div>
  );
}

function PlanList({ title, empty, children }: { title: string; empty?: string; children: React.ReactNode }) {
  const count = Array.isArray(children) ? children.filter(Boolean).length : children ? 1 : 0;
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {count === 0 && empty ? <p className="text-sm text-subtle">{empty}</p> : <ul className="flex flex-col gap-2">{children}</ul>}
    </section>
  );
}

function PlanItem({
  title,
  subtitle,
  children,
  onRemove,
  onEdit,
  disabled,
  removeLabel,
  plain,
}: {
  title: React.ReactNode;
  subtitle?: string | null;
  children?: React.ReactNode;
  onRemove: () => void;
  onEdit?: () => void;
  disabled?: boolean;
  removeLabel: string;
  plain?: boolean;
}) {
  return (
    <li className="flex items-start gap-1 rounded-md border border-line bg-bg p-2.5">
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm break-words", plain ? "text-ink" : "font-medium")}>{title}</p>
        {subtitle && <p className="text-xs text-subtle">{subtitle}</p>}
        {children && <div className="mt-1">{children}</div>}
      </div>
      {onEdit && (
        <IconButton label="Editar" size="sm" onClick={onEdit} disabled={disabled}>
          <Pencil className="size-4" />
        </IconButton>
      )}
      <IconButton label={removeLabel} size="sm" onClick={onRemove} disabled={disabled} className="hover:text-danger">
        <X className="size-4" />
      </IconButton>
    </li>
  );
}

function EditAgentDialog({ agent, onClose, onSave }: { agent: SetupPlan["agents"][number]; onClose: () => void; onSave: (patch: { name: string; role?: string; instructions: string }) => void }) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role ?? "");
  const [instructions, setInstructions] = useState(agent.instructions);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!name.trim()) return setError("Dê um nome ao agente.");
    if (!instructions.trim()) return setError("Escreva o que o agente faz.");
    onSave({ name: name.trim(), ...(role.trim() ? { role: role.trim() } : {}), instructions: instructions.trim() });
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Ajustar @${agent.handle}`}
      description="Você muda isso de novo quando quiser, no perfil do agente."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit}>
            Salvar no plano
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-autofocus />}</Field>
          <Field label="Função">{(id) => <Input id={id} value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} />}</Field>
        </div>
        <Field label="Instruções" hint="O que ele faz, para quem, em que tom e o que nunca faz.">
          {(id, d) => <Textarea id={id} aria-describedby={d} value={instructions} onChange={(e) => setInstructions(e.target.value)} className="min-h-56 text-sm" maxLength={8000} />}
        </Field>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}

// ---------- Depois de criar ----------
function ResultPanel({ plan, result, fromGuide, onMore }: { plan: SetupPlanDTO; result: SetupApplyResult; fromGuide: boolean; onMore: () => void }) {
  const ws = useWsId();
  const navigate = useNavigate();
  const catalog = useCatalog(ws);
  const [connecting, setConnecting] = useState<{ app: CatalogApp; index: number } | null>(null);
  const [granting, setGranting] = useState<number | null>(null);
  // O resultado gravado no hub é de quando o plano foi criado; as conexões feitas depois vêm da lista atual.
  const myUserId = useWorkspace((s) => s.myUserId);
  const [mine, setMine] = useState<ConnectorDTO[]>([]);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .listConnectors(ws)
      .then((l) => alive && setMine(l.filter((c) => c.ownerUserId === myUserId)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ws, myUserId]);
  const created = result.created;
  const lines: [string, string[]][] = [
    ["Agentes", created.agents],
    ["Canais", created.channels.map((c) => `#${c}`)],
    ["Rotinas", created.routines],
    ["Skills", created.skills],
    ["Páginas da wiki", created.wikiPages],
  ];
  const pending = result.pendingConnectors;
  const connectorFor = (i: number): ConnectorDTO | undefined => {
    const item = pending[i];
    if (!item) return undefined;
    return mine.find((c) => c.id === item.connectorId) ?? (item.catalogId ? mine.find((c) => c.catalogId === item.catalogId) : mine.find((c) => c.name.toLowerCase() === item.name.toLowerCase()));
  };
  /** Com login pelo site, só conta como feita depois de entrar. */
  const needsSignIn = (c: ConnectorDTO | undefined) => !!c && c.auth === "oauth" && c.oauthStatus !== "connected";
  const isDone = (i: number) => {
    const c = connectorFor(i);
    return c ? !needsSignIn(c) : !!pending[i]?.connectorId;
  };
  const allDone = pending.every((_, i) => isDone(i));
  const signIn = async (c: ConnectorDTO) => {
    setSigningIn(c.id);
    try {
      await startConnectorLogin(ws, c.id, paths.setup(ws));
    } catch (e) {
      toast.error(e);
      setSigningIn(null);
    }
  };

  /** Conector que já existia: libera para os agentes do plano. */
  const grantExisting = async (i: number) => {
    const item = pending[i]!;
    if (!item.connectorId || item.agentIds.length === 0) return;
    setGranting(i);
    try {
      await api.grantConnector(ws, item.connectorId, item.agentIds);
      toast.success(`${item.name} liberado para ${item.agentNames.join(", ")}.`);
    } catch (e) {
      toast.error(e);
    } finally {
      setGranting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-5 md:px-5">
      <div>
        <p className="flex items-center gap-2 text-base font-semibold text-success" role="status">
          <CheckCircle2 className="size-5" aria-hidden /> Estrutura criada
        </p>
        <p className="mt-1 text-sm text-muted">Você é o responsável pelos agentes novos e pode mudar tudo no perfil de cada um.</p>
      </div>
      <Card>
        <dl className="flex flex-col gap-2 text-sm">
          {lines
            .filter(([, items]) => items.length > 0)
            .map(([label, items]) => (
              <div key={label}>
                <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</dt>
                <dd className="break-words">{items.join(", ")}</dd>
              </div>
            ))}
          {created.memories > 0 && (
            <div>
              <dt className="text-xs font-semibold tracking-wide text-muted uppercase">Memória do time</dt>
              <dd>
                {created.memories} {created.memories === 1 ? "fato guardado" : "fatos guardados"}
              </dd>
            </div>
          )}
        </dl>
      </Card>

      {result.skipped.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Não foi criado</h3>
          <ul className="flex flex-col gap-1 text-sm text-muted">
            {result.skipped.map((s, i) => (
              <li key={i}>
                <span className="font-medium text-ink">{s.name}</span>: {s.reason}.
              </li>
            ))}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Conexões {allDone ? "feitas" : "que faltam"}</h3>
          <ul className="flex flex-col gap-2">
            {pending.map((c, i) => {
              const app = c.catalogId ? (catalog.apps?.find((a) => a.id === c.catalogId) ?? null) : null;
              const done = isDone(i);
              const existing = connectorFor(i);
              return (
                <li key={`${c.catalogId ?? c.name}:${i}`} className="rounded-md border border-line bg-bg p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                      <Plug className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{c.name}</p>
                      <p className="text-sm text-muted">{c.reason}</p>
                      {c.agentNames.length > 0 && <p className="mt-0.5 text-xs text-subtle">Para: {c.agentNames.join(", ")}</p>}
                    </div>
                    {done ? (
                      <Badge tone="success">Conectado</Badge>
                    ) : existing && needsSignIn(existing) ? (
                      <Button size="sm" variant="primary" loading={signingIn === existing.id} onClick={() => void signIn(existing)}>
                        Entrar
                      </Button>
                    ) : app ? (
                      <Button size="sm" variant="primary" onClick={() => setConnecting({ app, index: i })}>
                        Conectar
                      </Button>
                    ) : (
                      <Link to={paths.settings(ws, "conectores")} className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-sm font-medium hover:bg-surface-2 max-md:h-10">
                        Abrir conectores
                      </Link>
                    )}
                  </div>
                  {c.connectorId && c.agentIds.length > 0 && (
                    <p className="mt-2 text-xs text-muted">
                      Você já tinha esta conexão; os agentes do plano foram liberados.{" "}
                      <button type="button" className="font-medium underline" disabled={granting === i} onClick={() => void grantExisting(i)}>
                        Liberar de novo
                      </button>
                    </p>
                  )}
                  {!done && !app && (
                    <p className="mt-2 text-xs text-muted">
                      Este serviço não está no catálogo. Em Conectores, use “Conectar outro serviço” com o endereço do servidor MCP dele e depois libere o acesso no perfil
                      {c.agentNames.length ? ` de ${c.agentNames.join(", ")}` : " do agente"}.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Uma conexão só funciona quando o agente roda no computador de quem a conectou. Consultas rodam direto; ações que alteram algo passam pela checagem de permissão.
          </p>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <Button variant="ghost" onClick={onMore}>
          Montar mais
        </Button>
        <Button onClick={() => navigate(paths.team(ws))}>Ver a equipe</Button>
        {fromGuide && (
          <Button variant="primary" onClick={() => navigate(`${paths.onboarding(ws)}?passo=montar`)}>
            Voltar ao guia
          </Button>
        )}
      </div>

      {connecting && (
        <CatalogConnectDialog
          ws={ws}
          app={connecting.app}
          callbackUrl={catalog.callbackUrl}
          grantAgentIds={pending[connecting.index]?.agentIds ?? []}
          grantNames={pending[connecting.index]?.agentNames ?? []}
          returnTo={paths.setup(ws)}
          onClose={() => setConnecting(null)}
          onConnected={(conn) => setMine((l) => [...l.filter((x) => x.id !== conn.id), conn])}
        />
      )}
      <span className="sr-only">Plano {plan.id}</span>
    </div>
  );
}
