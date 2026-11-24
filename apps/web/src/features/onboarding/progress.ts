/**
 * Progresso do onboarding guiado e checklist "Primeiros passos".
 * Funções puras (testadas em progress.test.ts) + leitura/gravação por workspace no localStorage.
 */

/**
 * O computador vem antes de montar o time: quem monta é o agente criador, e ele precisa de um
 * computador ligado para trabalhar.
 */
export const STEPS = ["uso", "voce", "computador", "montar", "convite"] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_LABEL: Record<StepId, string> = {
  uso: "Tipo de espaço",
  voce: "Seu perfil",
  computador: "Ligar seu computador",
  montar: "Montar o time",
  convite: "Chamar o time",
};

export type WorkspaceKind = "personal" | "team";

export interface OnboardingProgress {
  kind: WorkspaceKind;
  current: StepId;
  done: StepId[];
  skipped: StepId[];
  finished: boolean;
  /** Checklist da tela inicial: recolhida ou dispensada. */
  checklistCollapsed: boolean;
  checklistDismissed: boolean;
  /** Gerou um link de convite (o hub não diz se alguém já entrou). */
  invited: boolean;
}

/** "Chamar o time" não se aplica a workspace individual. */
export function applicableSteps(kind: WorkspaceKind): StepId[] {
  return STEPS.filter((s) => kind === "team" || s !== "convite");
}

/** O passo "Tipo de espaço" já é respondido ao criar o workspace. */
export function initialProgress(kind: WorkspaceKind): OnboardingProgress {
  return {
    kind,
    current: "voce",
    done: ["uso"],
    skipped: [],
    finished: false,
    checklistCollapsed: false,
    checklistDismissed: false,
    invited: false,
  };
}

function settled(p: OnboardingProgress, s: StepId): boolean {
  return p.done.includes(s) || p.skipped.includes(s);
}

/** Próximo passo ainda pendente depois de `from` (ou o primeiro pendente antes dele); null se acabou. */
export function nextPending(p: OnboardingProgress, from: StepId): StepId | null {
  const steps = applicableSteps(p.kind);
  const i = steps.indexOf(from);
  const after = steps.slice(i + 1).find((s) => !settled(p, s));
  if (after) return after;
  return steps.find((s) => !settled(p, s)) ?? null;
}

function settle(p: OnboardingProgress, step: StepId, how: "done" | "skipped"): OnboardingProgress {
  const done = how === "done" ? [...new Set([...p.done, step])] : p.done.filter((s) => s !== step);
  const skipped = how === "skipped" ? [...new Set([...p.skipped, step])] : p.skipped.filter((s) => s !== step);
  const next: OnboardingProgress = { ...p, done, skipped };
  const n = nextPending(next, step);
  return { ...next, current: n ?? step, finished: n === null };
}

export const completeStep = (p: OnboardingProgress, step: StepId) => settle(p, step, "done");
export const skipStep = (p: OnboardingProgress, step: StepId) => settle(p, step, "skipped");

/** "Pular configuração": encerra o guia; o que ficou pendente continua na checklist. */
export function skipAll(p: OnboardingProgress): OnboardingProgress {
  const rest = applicableSteps(p.kind).filter((s) => !settled(p, s));
  return { ...p, skipped: [...p.skipped, ...rest], finished: true };
}

/** Voltar a um passo (para revisar ou retomar um pulado). */
export function goTo(p: OnboardingProgress, step: StepId): OnboardingProgress {
  if (!applicableSteps(p.kind).includes(step)) return p;
  return { ...p, current: step, finished: false };
}

export function stepNumber(p: OnboardingProgress, step: StepId): { n: number; total: number } {
  const steps = applicableSteps(p.kind);
  return { n: steps.indexOf(step) + 1, total: steps.length };
}

// ---------- Checklist "Primeiros passos" ----------
export interface ChecklistInput {
  kind: WorkspaceKind;
  /** Agentes criados (sem contar assistentes pessoais). */
  agentCount: number;
  myRunnerCount: number;
  memberCount: number;
  invited: boolean;
  /** Já mandou alguma mensagem a um agente (DM com agente com mensagens). */
  talkedToAgent: boolean;
  /** null = ainda não carregado. */
  taskCount: number | null;
}

export type ChecklistId = "agente" | "computador" | "convite" | "conversa" | "tarefa";

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  hint: string;
  done: boolean;
}

export function computeChecklist(i: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [
    { id: "agente", label: "Montar o time de agentes", hint: "Conte ao criador como você trabalha e ele propõe o time.", done: i.agentCount > 0 },
    { id: "computador", label: "Ligar seu computador", hint: "Os agentes rodam no seu computador, com a sua assinatura.", done: i.myRunnerCount > 0 },
    { id: "conversa", label: "Mandar a primeira mensagem para um agente", hint: "Abra a conversa com um agente e peça algo.", done: i.talkedToAgent },
    { id: "tarefa", label: "Criar uma tarefa", hint: "Use o quadro para acompanhar o trabalho de pessoas e agentes.", done: (i.taskCount ?? 0) > 0 },
  ];
  if (i.kind === "team") {
    items.splice(2, 0, { id: "convite", label: "Convidar alguém do time", hint: "Gere um link de convite e mande para quem trabalha com você.", done: i.memberCount > 1 || i.invited });
  }
  return items;
}

export function pendingCount(items: ChecklistItem[]): number {
  return items.filter((x) => !x.done).length;
}

// ---------- Armazenamento ----------
const key = (ws: string) => `tb-onboarding:${ws}`;

export function loadProgress(ws: string): OnboardingProgress | null {
  try {
    const raw = localStorage.getItem(key(ws));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<OnboardingProgress>;
    if (!p || typeof p !== "object" || !p.kind) return null;
    const base = initialProgress(p.kind);
    // Guias salvos antes da troca: "Área de atuação" e "Agentes iniciais" viraram "Montar o time".
    const migrate = (s: string): string => (s === "time" || s === "negocio" ? "montar" : s);
    const valid = (list: string[] | undefined, fallback: StepId[]): StepId[] => [
      ...new Set((list ?? fallback).map(migrate).filter((s): s is StepId => (STEPS as readonly string[]).includes(s))),
    ];
    const done = valid(p.done, base.done);
    const current = migrate(p.current ?? "");
    return {
      ...base,
      ...p,
      done,
      skipped: valid(p.skipped, []).filter((s) => !done.includes(s)),
      current: (STEPS as readonly string[]).includes(current) ? (current as StepId) : base.current,
    };
  } catch {
    return null;
  }
}

export function saveProgress(ws: string, p: OnboardingProgress): void {
  try {
    localStorage.setItem(key(ws), JSON.stringify(p));
  } catch {
    /* sem armazenamento: o guia só não fica salvo */
  }
}
