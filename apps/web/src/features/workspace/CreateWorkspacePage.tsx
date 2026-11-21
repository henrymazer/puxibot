import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { User, Users } from "lucide-react";
import { createWorkspaceSchema } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useSession } from "../../store/session";
import { Button, Field, InlineError, Input } from "../../components/ui";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { AuthLayout } from "../auth/AuthLayout";
import { initialProgress, saveProgress } from "../onboarding/progress";


export function CreateWorkspacePage() {
  const workspaces = useSession((s) => s.workspaces);
  const user = useSession((s) => s.user);
  const addWorkspace = useSession((s) => s.addWorkspace);
  const navigate = useNavigate();
  const [kind, setKind] = useState<"personal" | "team">("team");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const finalName = name.trim() || (kind === "personal" ? `Espaço de ${user?.name.split(" ")[0] ?? "você"}` : "");
    const parsed = createWorkspaceSchema.safeParse({ name: finalName, kind });
    if (!parsed.success) {
      setError("Dê um nome ao workspace.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ws = await api.createWorkspace(parsed.data);
      addWorkspace(ws);
      // O resto (perfil, computador, área de atuação, agentes e convites) é perguntado no guia.
      saveProgress(ws.id, initialProgress(ws.kind ?? kind));
      navigate(paths.onboarding(ws.id), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Criar workspace"
      subtitle="É onde ficam os canais, as pessoas e os agentes. Depois disso, um guia rápido ajuda a configurar o resto."
      footer={workspaces.length > 0 ? <Link to="/" className="text-primary-text underline">Voltar</Link> : undefined}
    >
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Para quem é?</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {(
              [
                ["personal", "Individual", "Um espaço só seu", User],
                ["team", "Em equipe", "Várias pessoas e agentes", Users],
              ] as const
            ).map(([id, label, hint, Icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={kind === id}
                onClick={() => setKind(id)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                  kind === id ? "border-primary bg-primary-soft" : "border-line-strong bg-surface hover:bg-surface-2",
                )}
              >
                <Icon className={cn("size-5", kind === id ? "text-primary-text" : "text-muted")} aria-hidden />
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-xs text-muted">{hint}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Nome" hint={kind === "personal" ? "Pode deixar em branco." : "Ex.: o nome da empresa ou do projeto."}>
          {(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}
        </Field>
        <InlineError message={error} />
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Criar workspace
        </Button>
      </form>
    </AuthLayout>
  );
}
