import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { api, errorMessage } from "../../api";
import { useSession } from "../../store/session";
import { useWorkspace } from "../../store/workspace";
import { useWsId } from "../shell/hooks";
import { AVATAR_COLORS, PersonAvatar } from "../../components/Avatar";
import { Button, Card, Field, InlineError, Input, SectionTitle } from "../../components/ui";
import { toast } from "../../components/toast";
import { useTheme, type ThemePref } from "../../lib/theme";
import { ROLE_LABEL } from "../../lib/actors";
import { cn } from "../../lib/cn";

const STATUS_PRESETS = ["Em foco", "Em reunião", "Volto logo", "Fora hoje"];

export function ProfileSettings() {
  return (
    <>
      <ProfileCard />
      <StatusCard />
      <ThemeCard />
    </>
  );
}

function patchMember(userId: string, patch: Record<string, unknown>) {
  useWorkspace.setState((s) => {
    const m = s.members[userId];
    if (!m) return {};
    const updated = { ...m, ...patch };
    return { members: { ...s.members, [userId]: updated }, me: s.me?.userId === userId ? updated : s.me };
  });
}

function ProfileCard() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const me = useWorkspace((s) => s.me);
  const [name, setName] = useState(user?.name ?? "");
  const [color, setColor] = useState<string | null>(user?.avatarColor ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return null;
  const dirty = name.trim() !== user.name || color !== user.avatarColor;

  const save = async () => {
    if (!name.trim()) {
      setError("Seu nome não pode ficar vazio.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateMe({ name: name.trim(), avatarColor: color });
      setUser(updated);
      patchMember(updated.id, { name: updated.name, avatarColor: updated.avatarColor });
      toast.success("Perfil salvo.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Seu perfil</SectionTitle>
      <div className="mb-4 flex items-center gap-3">
        <PersonAvatar name={name || user.name} color={color} member={{ userId: user.id, name: name || user.name, avatarColor: color }} size="lg" />
        <div className="min-w-0">
          <div className="truncate font-medium">{name || user.name}</div>
          <div className="truncate text-sm text-muted">{user.email}</div>
          {me && <div className="text-xs text-subtle">{ROLE_LABEL[me.role]} neste workspace</div>}
        </div>
      </div>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Nome">{(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />}</Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Cor do avatar</legend>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Cor ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn("flex size-9 items-center justify-center rounded-full border-2 max-md:size-10", color === c ? "border-ink" : "border-transparent")}
                style={{ background: c }}
              >
                {color === c && <Check className="size-4 text-white" aria-hidden />}
              </button>
            ))}
          </div>
        </fieldset>
        <InlineError message={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
            Salvar
          </Button>
        </div>
      </form>
    </Card>
  );
}

function StatusCard() {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const [text, setText] = useState(me?.statusText ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(me?.statusText ?? ""), [me?.statusText]);
  if (!me) return null;

  const save = async (value: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api.updateMember(ws, me.userId, { statusText: value });
      patchMember(me.userId, { statusText: value });
      setText(value ?? "");
      toast.success(value ? "Status atualizado." : "Status limpo.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Status</SectionTitle>
      <p className="mb-3 text-sm text-muted">Aparece ao lado do seu nome para o time.</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {STATUS_PRESETS.map((p) => (
          <Button key={p} size="sm" variant={me.statusText === p ? "primary" : "secondary"} onClick={() => void save(p)} disabled={saving}>
            {p}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void save(text.trim() || null);
        }}
      >
        <Field label="Status personalizado" className="flex-1">
          {(id, d) => <Input id={id} aria-describedby={d} value={text} onChange={(e) => setText(e.target.value)} maxLength={80} placeholder="Ex.: Focado até as 15h" />}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={saving} disabled={(text.trim() || null) === (me.statusText || null)}>
            Salvar
          </Button>
          <Button onClick={() => void save(null)} disabled={saving || !me.statusText}>
            Limpar
          </Button>
        </div>
      </form>
      <div className="mt-2">
        <InlineError message={error} />
      </div>
    </Card>
  );
}

function ThemeCard() {
  const theme = useTheme();
  const options: [ThemePref, string, typeof Sun][] = [
    ["system", "Seguir o sistema", Monitor],
    ["light", "Claro", Sun],
    ["dark", "Escuro", Moon],
  ];
  return (
    <Card>
      <SectionTitle>Aparência</SectionTitle>
      <div role="radiogroup" aria-label="Tema" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {options.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={theme.pref === id}
            onClick={() => theme.set(id)}
            className={cn(
              "flex h-11 items-center justify-center gap-2 rounded-md border text-sm",
              theme.pref === id ? "border-primary bg-primary-soft font-medium text-primary-text" : "border-line text-muted hover:bg-surface-2",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </Card>
  );
}
