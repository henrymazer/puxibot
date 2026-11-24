import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, CheckCircle2, Laptop, Sparkles, User, Users } from "lucide-react";
import type { AgentDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { useSession } from "../../store/session";
import { isAdmin } from "../../lib/actors";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { AgentAvatar } from "../../components/Avatar";
import { Badge, Button, Card, Field, InlineError, Input, LockedNote, Select } from "../../components/ui";
import { toast } from "../../components/toast";
import { PageHeader } from "../shell/PageHeader";
import { useWsId } from "../shell/hooks";
import { InstallRunnerSteps } from "../settings/InstallRunner";
import { PairForm } from "../settings/PairForm";
import { CopyBox } from "../settings/CopyBox";
import {
  applicableSteps,
  completeStep,
  goTo,
  skipAll,
  skipStep,
  STEP_LABEL,
  stepNumber,
  type OnboardingProgress,
  type StepId,
} from "./progress";
import { useOnboardingProgress } from "./useOnboarding";
import { pickStarterTemplate, STARTER_TEMPLATES } from "./starterTemplates";

export const OTHER_BUSINESS = "Outra área";
export const BUSINESSES = ["Marketing e criação", "Comércio", "Tecnologia", "Consultoria e serviços", OTHER_BUSINESS];

interface StepProps {
  progress: OnboardingProgress;
  /** Conclui o passo (e avança). */
  done: () => void;
  skip: () => void;
  back: (() => void) | null;
  update: (fn: (p: OnboardingProgress) => OnboardingProgress) => void;
}

export function OnboardingPage() {
  const ws = useWsId();
  const navigate = useNavigate();
  const { progress, update } = useOnboardingProgress(ws);
  const steps = applicableSteps(progress.kind);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const current = progress.current;
  const { n, total } = stepNumber(progress, current);
  const [params, setParams] = useSearchParams();
  const asked = params.get("passo");

  // `?passo=computador` (links da checklist) abre direto naquele passo.
  useEffect(() => {
    if (!asked) return;
    if ((steps as string[]).includes(asked)) update((p) => goTo(p, asked as StepId));
    setParams((q) => {
      const next = new URLSearchParams(q);
      next.delete("passo");
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  // Leva o foco ao título a cada passo (leitores de tela e teclado).
  useEffect(() => {
    headingRef.current?.focus();
  }, [current, progress.finished]);

  const idx = steps.indexOf(current);
  const back = idx > 0 ? () => update((p) => goTo(p, steps[idx - 1]!)) : null;
  const stepProps: StepProps = {
    progress,
    done: () => update((p) => completeStep(p, current)),
    skip: () => update((p) => skipStep(p, current)),
    back,
    update,
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title={
          <>
            <span className="sm:hidden">Configuração</span>
            <span className="max-sm:hidden">Configurar o workspace</span>
          </>
        }
        icon={<Sparkles className="size-5" />}
        subtitle={progress.finished ? "Tudo certo" : `Passo ${n} de ${total}`}
        actions={
          !progress.finished && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                update(skipAll);
                navigate(paths.workspace(ws));
              }}
            >
              <span className="sm:hidden">Sair do guia</span>
              <span className="max-sm:hidden">Pular configuração</span>
            </Button>
          )
        }
      />
      <div className="tb-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:flex-row md:gap-8 md:px-6 md:py-8">
          <nav aria-label="Passos da configuração" className="md:w-56 md:shrink-0">
            <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-3 md:hidden" aria-hidden>
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(progress.done.length / total) * 100}%` }} />
            </div>
            <ol className="flex gap-1 overflow-x-auto max-md:hidden md:flex-col">
              {steps.map((s, i) => {
                const isDone = progress.done.includes(s);
                const isSkipped = progress.skipped.includes(s);
                const active = !progress.finished && s === current;
                return (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => update((p) => goTo(p, s))}
                      aria-current={active ? "step" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                        active ? "bg-primary-soft font-medium text-primary-text" : "text-muted hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                          isDone ? "border-primary bg-primary text-primary-fg" : active ? "border-primary text-primary-text" : "border-line-strong",
                        )}
                        aria-hidden
                      >
                        {isDone ? <Check className="size-3.5" /> : i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{STEP_LABEL[s]}</span>
                      {isSkipped && <span className="text-xs text-subtle">pulado</span>}
                      <span className="sr-only">{isDone ? "(feito)" : isSkipped ? "(pulado)" : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <section className="min-w-0 flex-1" aria-labelledby="onb-title">
            {progress.finished ? (
              <Finished headingRef={headingRef} progress={progress} onReview={(s) => update((p) => goTo(p, s))} />
            ) : (
              <>
                <h2 id="onb-title" ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
                  {STEP_LABEL[current]}
                </h2>
                <div className="mt-4">
                  {current === "uso" && <UsoStep {...stepProps} />}
                  {current === "voce" && <VoceStep {...stepProps} />}
                  {current === "montar" && <MontarStep {...stepProps} />}
                  {current === "computador" && <ComputadorStep {...stepProps} />}
                  {current === "convite" && <ConviteStep {...stepProps} />}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function StepFooter({
  back,
  skip,
  primary,
  onPrimary,
  loading,
  disabled,
  skipLabel = "Pular",
}: {
  back: (() => void) | null;
  skip?: () => void;
  primary: string;
  onPrimary: () => void;
  loading?: boolean;
  disabled?: boolean;
  skipLabel?: string;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
      {back && (
        <Button variant="ghost" onClick={back}>
          Voltar
        </Button>
      )}
      <span className="flex-1" />
      {skip && <Button onClick={skip}>{skipLabel}</Button>}
      <Button variant="primary" onClick={onPrimary} loading={loading} disabled={disabled}>
        {primary}
      </Button>
    </div>
  );
}

function Choice({ selected, onClick, icon, title, text, disabled }: { selected: boolean; onClick?: () => void; icon: ReactNode; title: string; text: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors disabled:cursor-default",
        selected ? "border-primary bg-primary-soft" : "border-line-strong bg-surface",
        !disabled && !selected && "hover:bg-surface-2",
      )}
    >
      <span className={cn(selected ? "text-primary-text" : "text-muted")}>{icon}</span>
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs text-muted">{text}</span>
    </button>
  );
}

// ---------- Tipo de espaço ----------
function UsoStep({ progress, done, back }: StepProps) {
  return (
    <>
      <p className="text-sm text-muted">Isto foi escolhido ao criar o workspace e muda o que sugerimos nos próximos passos.</p>
      <div role="radiogroup" aria-label="Tipo de espaço" className="mt-4 grid gap-3 sm:grid-cols-2">
        <Choice selected={progress.kind === "personal"} disabled icon={<User className="size-5" />} title="Individual" text="Um espaço só seu, com os seus agentes." />
        <Choice selected={progress.kind === "team"} disabled icon={<Users className="size-5" />} title="Em equipe" text="Várias pessoas e agentes no mesmo espaço." />
      </div>
      <p className="mt-3 text-xs text-subtle">Para usar de outro jeito, crie outro workspace no menu do workspace.</p>
      <StepFooter back={back} primary="Continuar" onPrimary={done} />
    </>
  );
}

// ---------- Seu perfil ----------
function VoceStep({ done, skip, back }: StepProps) {
  const ws = useWsId();
  const user = useSession((s) => s.user);
  const me = useWorkspace((s) => s.me);
  const [name, setName] = useState(user?.name ?? me?.name ?? "");
  const [title, setTitle] = useState(me?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError("Diga como quer ser chamado.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (user && name.trim() !== user.name) {
        const u = await api.updateMe({ name: name.trim() });
        useSession.getState().setUser(u && u.id ? u : { ...user, name: name.trim() });
      }
      const t = title.trim() || null;
      let member = me ? { ...me, name: name.trim() } : null;
      if (me && t !== me.title) {
        const m = await api.updateMember(ws, me.userId, { title: t });
        member = m && m.userId ? m : { ...me, name: name.trim(), title: t };
      }
      if (member) {
        const mm = member;
        useWorkspace.setState((s) => ({ me: mm, members: { ...s.members, [mm.userId]: mm } }));
      }
      done();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="text-sm text-muted">Os agentes usam isso para saber com quem estão falando.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Como quer ser chamado">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />}
        </Field>
        <Field label="O que você faz" hint="Ex.: Direção, Design, Atendimento.">
          {(id, d) => <Input id={id} aria-describedby={d} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />}
        </Field>
      </div>
      <div className="mt-3">
        <InlineError message={error} />
      </div>
      <StepFooter back={back} skip={skip} primary="Continuar" onPrimary={() => void save()} loading={busy} />
    </>
  );
}

// ---------- Montar o time ----------
/**
 * O time é montado pelo agente criador, numa conversa. Ele roda no computador da pessoa, então este
 * passo vem depois de "Ligar seu computador". Sem computador ligado, a saída é o time básico pronto.
 */
function MontarStep(props: StepProps) {
  const { done, skip, back } = props;
  const ws = useWsId();
  const navigate = useNavigate();
  const myUserId = useWorkspace((s) => s.myUserId);
  const runners = useWorkspace((s) => s.runners);
  const agents = useWorkspace((s) => s.agents);
  const online = Object.values(runners).some((r) => r.userId === myUserId && r.online);
  const mine = useMemo(() => Object.values(agents).filter((a) => !a.isAssistant && a.systemKind !== "builder"), [agents]);
  const [basic, setBasic] = useState(false);

  if (basic) return <TimeStep {...props} back={() => setBasic(false)} />;

  return (
    <>
      <p className="text-sm text-muted">
        Conte ao criador como o seu trabalho funciona hoje e o que você quer que os agentes façam. Ele faz poucas perguntas e propõe canais, agentes, rotinas
        e as ferramentas a conectar. Você revisa tudo antes de criar.
      </p>
      {mine.length > 0 && (
        <p className="mt-3 flex items-center gap-2 text-sm font-medium text-success" role="status">
          <CheckCircle2 className="size-5" aria-hidden /> O workspace já tem {mine.length} {mine.length === 1 ? "agente" : "agentes"}.
        </p>
      )}
      <Card className="mt-4">
        <p className="font-medium">O que dizer para começar</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          <li>O que a empresa ou o time faz, e para quem.</li>
          <li>Quem cuida de quê hoje, e o que mais toma tempo.</li>
          <li>Que ferramentas vocês usam (anúncios, e-mail, planilhas, gestão de projetos).</li>
        </ul>
      </Card>
      {!online && (
        <Card className="mt-4 bg-warning-soft">
          <p className="font-medium text-warning">O criador precisa de um computador ligado</p>
          <p className="mt-1 text-sm text-muted">
            Ele é um agente como os outros e trabalha no seu computador. Volte um passo para ligar, ou comece com um time básico pronto e chame o criador
            depois, pela tela Equipe.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {back && (
              <Button size="sm" onClick={back}>
                Ligar meu computador
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setBasic(true)}>
              Usar um time básico
            </Button>
          </div>
        </Card>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {back && (
          <Button variant="ghost" onClick={back}>
            Voltar
          </Button>
        )}
        <span className="flex-1" />
        <Button onClick={mine.length > 0 ? done : skip}>{mine.length > 0 ? "Continuar" : "Montar depois"}</Button>
        <Button variant="primary" disabled={!online} onClick={() => navigate(`${paths.setup(ws)}?guia=1`)}>
          {mine.length > 0 ? "Montar mais com o criador" : "Conversar com o criador"}
        </Button>
      </div>
    </>
  );
}

// ---------- Time básico (sem computador ligado) ----------
function TimeStep({ done, skip, back }: StepProps) {
  const ws = useWsId();
  const workspace = useWorkspace((s) => s.workspace);
  const agents = useWorkspace((s) => s.agents);
  const me = useWorkspace((s) => s.me);
  const existing = useMemo(() => Object.values(agents).filter((a) => !a.isAssistant), [agents]);
  const [tplKey, setTplKey] = useState(() => pickStarterTemplate(workspace?.business).key);
  const tpl = STARTER_TEMPLATES.find((t) => t.key === tplKey)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AgentDTO[] | null>(null);
  const [suggest, setSuggest] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createStarterTeam(ws, { business: tplKey });
      const st = useWorkspace.getState();
      for (const a of res.agents) st.upsertAgent(a);
      for (const c of res.channels) st.upsertChannel(c);
      setCreated(res.agents);
      toast.success(
        res.createdAgents > 0
          ? `${res.createdAgents} ${res.createdAgents === 1 ? "agente criado" : "agentes criados"}${res.createdChannels ? ` e ${res.createdChannels} ${res.createdChannels === 1 ? "canal" : "canais"}` : ""}.`
          : "O time inicial já existia.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <>
        <p className="flex items-center gap-2 text-sm font-medium text-success" role="status">
          <CheckCircle2 className="size-5" aria-hidden /> Time criado. Você é o responsável por eles e pode mudar tudo no perfil de cada um.
        </p>
        <AgentList agents={created.map((a) => ({ id: a.id, name: a.name, role: a.role ?? "", description: a.description ?? "", avatarColor: a.avatarColor }))} />
        <StepFooter back={back} primary="Continuar" onPrimary={done} />
      </>
    );
  }

  if (existing.length > 0 && !suggest) {
    return (
      <>
        <p className="text-sm text-muted">
          O workspace já tem {existing.length} {existing.length === 1 ? "agente" : "agentes"}. Dá para criar mais na Equipe quando quiser.
        </p>
        <AgentList agents={existing.map((a) => ({ id: a.id, name: a.name, role: a.role ?? "", description: a.description ?? "", avatarColor: a.avatarColor }))} />
        <Button variant="ghost" className="mt-3" onClick={() => setSuggest(true)}>
          Ver o time sugerido para o ramo
        </Button>
        <StepFooter back={back} primary="Continuar" onPrimary={done} />
      </>
    );
  }

  return (
    <>
      <p className="text-sm text-muted">
        Montamos um time inicial para o seu ramo. Cada agente já vem com instruções e entra nos canais certos. {me && `Você fica como responsável.`}
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Modelo de time" className="w-full sm:w-60">
          {(id) => (
            <Select id={id} value={tplKey} onChange={(e) => setTplKey(e.target.value as typeof tplKey)}>
              {STARTER_TEMPLATES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.key === "generico" ? "Time geral" : t.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <AgentList agents={tpl.agents.map((a) => ({ id: `preview-${a.handle}`, name: a.name, role: a.role, description: a.description, avatarColor: a.avatarColor }))} />
      <p className="mt-3 text-sm text-muted">
        Canais: {tpl.channels.map((c) => `#${c.name}`).join(", ")}.
      </p>
      <div className="mt-3">
        <InlineError message={error} />
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {back && (
          <Button variant="ghost" onClick={back}>
            Voltar
          </Button>
        )}
        <span className="flex-1" />
        <Button onClick={existing.length > 0 ? () => setSuggest(false) : skip}>{existing.length > 0 ? "Manter como está" : "Começar vazio"}</Button>
        <Button variant="primary" onClick={() => void create()} loading={busy}>
          Criar este time
        </Button>
      </div>
    </>
  );
}

function AgentList({ agents }: { agents: { id: string; name: string; role: string; description: string; avatarColor: string | null }[] }) {
  return (
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">
      {agents.map((a) => (
        <li key={a.id} className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3">
          <AgentAvatar agent={{ id: a.id, name: a.name, avatarColor: a.avatarColor, avatarAccessory: null }} size="md" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 text-sm">
              <span className="font-semibold">{a.name}</span>
              {a.role && <span className="text-xs text-muted">{a.role}</span>}
            </div>
            <p className="text-xs text-muted">{a.description}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------- 5. Ligar seu computador ----------
function ComputadorStep({ done, skip, back }: StepProps) {
  const myUserId = useWorkspace((s) => s.myUserId);
  const runners = useWorkspace((s) => s.runners);
  const online = Object.values(runners).filter((r) => r.userId === myUserId && r.online);
  // Detecta a transição para "ligado" durante este passo, para comemorar.
  const [wasOffline] = useState(online.length === 0);
  const first = online[0];

  return (
    <>
      <p className="text-sm text-muted">
        Os agentes trabalham no seu computador, com a CLI de IA que você já usa (Claude Code, Codex ou Gemini CLI). Sem nenhum computador ligado, eles esperam na fila.
      </p>
      {first ? (
        <Card className="mt-4 bg-success-soft">
          <p className="flex items-center gap-2 font-medium text-success" role="status" aria-live="polite">
            <CheckCircle2 className="size-5" aria-hidden />
            {wasOffline ? "Pronto! Seu computador ligou." : "Seu computador está ligado."}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
            <Laptop className="size-4" aria-hidden /> {first.name}
            {first.clis.length > 0 && ` · ${first.clis.map((c) => c.cli).join(", ")}`}
          </p>
        </Card>
      ) : (
        <>
          <Card className="mt-4">
            <InstallRunnerSteps compact />
          </Card>
          <Card className="mt-4">
            <h3 className="mb-1 text-sm font-semibold">Aprovar o computador</h3>
            <p className="mb-3 text-sm text-muted">Depois do <code className="font-mono text-xs">puxibot login</code>, digite aqui o código que apareceu no terminal.</p>
            <PairForm />
            <p className="mt-3 flex items-center gap-2 text-xs text-muted" role="status" aria-live="polite">
              <span className="tb-dot-pulse size-2 rounded-full bg-agent" aria-hidden />
              Esperando seu computador ligar…
            </p>
          </Card>
        </>
      )}
      <StepFooter back={back} skip={first ? undefined : skip} skipLabel="Fazer depois" primary="Continuar" onPrimary={done} disabled={!first} />
    </>
  );
}

// ---------- Chamar o time ----------
function ConviteStep({ done, skip, back, update }: StepProps) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const admin = isAdmin(me?.role);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createInvite(ws, { role: "member", maxUses: 10, expiresInDays: 7 });
      setUrl(res.url || `${location.origin}/convite/${res.code}`);
      update((p) => ({ ...p, invited: true }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="text-sm text-muted">Mande o link para quem trabalha com você. Cada pessoa ganha um assistente pessoal ao entrar.</p>
      {!admin ? (
        <div className="mt-4">
          <LockedNote>Só admins convidam pessoas. Peça a um admin um link de convite.</LockedNote>
        </div>
      ) : url ? (
        <div className="mt-4 space-y-2">
          <CopyBox value={url} label="Copiar link de convite" />
          <p className="text-xs text-muted">Vale por 7 dias, para até 10 pessoas. Entram como membros; você muda o papel depois na Equipe.</p>
        </div>
      ) : (
        <Button className="mt-4" onClick={() => void generate()} loading={busy}>
          Gerar link de convite
        </Button>
      )}
      <div className="mt-3">
        <InlineError message={error} />
      </div>
      <StepFooter back={back} skip={url ? undefined : skip} skipLabel="Convidar depois" primary="Concluir" onPrimary={done} disabled={!url && admin} />
    </>
  );
}

// ---------- Fim ----------
function Finished({
  headingRef,
  progress,
  onReview,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  progress: OnboardingProgress;
  onReview: (s: StepId) => void;
}) {
  const ws = useWsId();
  return (
    <div>
      <h2 id="onb-title" ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-xl font-semibold outline-none">
        <CheckCircle2 className="size-6 text-success" aria-hidden /> Tudo pronto
      </h2>
      <p className="mt-2 text-sm text-muted">A tela inicial mostra o que precisa de você e os primeiros passos que faltam.</p>
      {progress.skipped.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium">Ficou para depois:</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {progress.skipped.map((s) => (
              <li key={s}>
                <Button size="sm" onClick={() => onReview(s)}>
                  {STEP_LABEL[s]}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Link to={paths.workspace(ws)} className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover">
          Ir para o início
        </Link>
        <Badge className="self-center">{progress.done.length - 1} de {applicableSteps(progress.kind).length - 1} passos feitos</Badge>
      </div>
    </div>
  );
}
