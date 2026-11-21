/**
 * Avatares. Pessoas: círculo com iniciais. Agentes: forma geométrica gerada pelo id,
 * com "visor" e acessório opcional, para nunca serem confundidos com pessoas.
 */
import type { AgentDTO, MemberDTO } from "@puxibot/shared";
import { cn } from "../lib/cn";
import { initials } from "../lib/format";

export const AVATAR_COLORS = ["#3f7d6e", "#3f6fa8", "#6a5fa8", "#a0574a", "#c2683f", "#8a7a3a", "#5a8a4a", "#8a5aa0", "#4f7f99", "#9a5a72"];
export const AGENT_ACCESSORIES = [
  { id: "", label: "Nenhum" },
  { id: "antenna", label: "Antena" },
  { id: "headset", label: "Fone" },
  { id: "glasses", label: "Óculos" },
  { id: "star", label: "Estrela" },
  { id: "leaf", label: "Folha" },
  { id: "bolt", label: "Raio" },
] as const;

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function colorFor(seed: string, explicit?: string | null): string {
  if (explicit && /^#[0-9a-f]{3,8}$/i.test(explicit)) return explicit;
  return AVATAR_COLORS[hash(seed) % AVATAR_COLORS.length]!;
}

const SIZES = { xs: 20, sm: 28, md: 36, lg: 48, xl: 72 } as const;
type AvatarSize = keyof typeof SIZES;

export function PersonAvatar({
  member,
  name,
  color,
  size = "md",
  presence,
  className,
}: {
  member?: Pick<MemberDTO, "name" | "avatarColor" | "userId"> | null;
  name?: string;
  color?: string | null;
  size?: AvatarSize;
  presence?: boolean | null;
  className?: string;
}) {
  const px = SIZES[size];
  const label = member?.name ?? name ?? "?";
  const bg = colorFor(member?.userId ?? label, member?.avatarColor ?? color);
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: px, height: px }} aria-hidden>
      <span
        className="flex size-full items-center justify-center rounded-full font-semibold text-white"
        style={{ background: bg, fontSize: Math.max(9, px * 0.38) }}
      >
        {initials(label)}
      </span>
      {presence !== undefined && presence !== null && <PresenceDot online={presence} size={size} />}
    </span>
  );
}

export function PresenceDot({ online, size = "md" }: { online: boolean; size?: AvatarSize }) {
  const d = size === "xs" || size === "sm" ? 9 : 11;
  return (
    <span
      className={cn(
        "absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-[var(--tb-sidebar)]",
        online ? "bg-success" : "bg-surface-3",
      )}
      style={{ width: d, height: d }}
    />
  );
}

const SHAPES = ["hex", "squircle", "octagon", "shield"] as const;

function shapePath(kind: (typeof SHAPES)[number]): string {
  switch (kind) {
    case "hex":
      return "M50 4 L90 27 L90 73 L50 96 L10 73 L10 27 Z";
    case "octagon":
      return "M32 6 H68 L94 32 V68 L68 94 H32 L6 68 V32 Z";
    case "shield":
      return "M50 5 C70 5 92 10 92 30 V56 C92 78 70 92 50 96 C30 92 8 78 8 56 V30 C8 10 30 5 50 5 Z";
    default:
      return "M50 6 C86 6 94 14 94 50 C94 86 86 94 50 94 C14 94 6 86 6 50 C6 14 14 6 50 6 Z";
  }
}

function Accessory({ kind }: { kind: string | null | undefined }) {
  const stroke = "rgba(255,255,255,0.95)";
  switch (kind) {
    case "antenna":
      return (
        <g>
          <line x1="50" y1="22" x2="50" y2="8" stroke={stroke} strokeWidth="5" strokeLinecap="round" />
          <circle cx="50" cy="8" r="6" fill="#f2c46b" />
        </g>
      );
    case "headset":
      return (
        <g fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round">
          <path d="M22 52 C22 28 78 28 78 52" />
          <rect x="15" y="48" width="10" height="18" rx="4" fill={stroke} />
          <rect x="75" y="48" width="10" height="18" rx="4" fill={stroke} />
        </g>
      );
    case "glasses":
      return (
        <g fill="none" stroke="#1f2328" strokeWidth="4">
          <circle cx="37" cy="50" r="10" />
          <circle cx="63" cy="50" r="10" />
          <line x1="47" y1="50" x2="53" y2="50" />
        </g>
      );
    case "star":
      return <path d="M76 12 L80 22 L91 23 L83 30 L85 41 L76 35 L67 41 L69 30 L61 23 L72 22 Z" fill="#f2c46b" />;
    case "leaf":
      return <path d="M70 26 C70 12 84 8 92 8 C92 18 88 30 74 30 Z" fill="#9fd39a" stroke="rgba(0,0,0,0.15)" />;
    case "bolt":
      return <path d="M80 8 L68 28 H78 L70 44 L90 20 H80 L86 8 Z" fill="#f2c46b" />;
    default:
      return null;
  }
}

export function AgentAvatar({
  agent,
  size = "md",
  className,
  showActivity,
}: {
  agent: Pick<AgentDTO, "id" | "name" | "avatarColor" | "avatarAccessory"> & Partial<Pick<AgentDTO, "activity" | "status">>;
  size?: AvatarSize;
  className?: string;
  showActivity?: boolean;
}) {
  const px = SIZES[size];
  const h = hash(agent.id);
  const shape = SHAPES[h % SHAPES.length]!;
  const color = colorFor(agent.id, agent.avatarColor);
  const eyeGap = 9 + (h % 3) * 2;
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: px, height: px }} aria-hidden>
      <svg viewBox="0 0 100 100" width={px} height={px} className={cn(agent.status === "paused" && "opacity-55 grayscale")}>
        <path d={shapePath(shape)} fill={color} />
        <rect x="24" y="40" width="52" height="22" rx="11" fill="rgba(15,18,22,0.78)" />
        <circle cx={50 - eyeGap} cy="51" r="4.5" fill="#f6f5f1" />
        <circle cx={50 + eyeGap} cy="51" r="4.5" fill="#f6f5f1" />
        {size !== "xs" && <Accessory kind={agent.avatarAccessory} />}
      </svg>
      {showActivity && agent.activity && agent.activity !== "idle" && <ActivityDot activity={agent.activity} />}
    </span>
  );
}

export function ActivityDot({ activity }: { activity: AgentDTO["activity"] }) {
  const cls =
    activity === "working"
      ? "bg-agent tb-dot-pulse"
      : activity === "waiting_approval"
        ? "bg-warning"
        : activity === "error"
          ? "bg-danger"
          : "bg-subtle";
  return <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-[var(--tb-sidebar)]", cls)} />;
}
