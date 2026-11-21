import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { loginSchema, signupSchema } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useSession } from "../../store/session";
import { Button, Field, InlineError, Input } from "../../components/ui";
import { paths } from "../../lib/paths";
import { AuthLayout } from "./AuthLayout";

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const status = useSession((s) => s.status);
  const load = useSession((s) => s.load);
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "authed") return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = loginSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      setError(!email.includes("@") ? "Digite um e-mail válido." : "Digite sua senha.");
      return;
    }
    setBusy(true);
    try {
      await api.login(parsed.data.email, parsed.data.password);
      await load();
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Entrar"
      subtitle="Seu time e seus agentes estão esperando."
      footer={
        <>
          Ainda não tem conta?{" "}
          <Link className="font-medium text-primary-text underline" to={`${paths.signup}${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>
            Criar conta
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="E-mail">
          {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}
        </Field>
        <Field label="Senha">
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <InlineError message={error} />
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Entrar
        </Button>
      </form>
    </AuthLayout>
  );
}

export function SignupPage() {
  const [params] = useSearchParams();
  const inviteCode = params.get("convite") ?? undefined;
  const next = safeNext(params.get("next"));
  const status = useSession((s) => s.status);
  const load = useSession((s) => s.load);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sem convite, só a primeira conta da instalação entra (ou qualquer pessoa, se o cadastro estiver aberto).
  const [gate, setGate] = useState<{ open: boolean; firstAccount: boolean } | null>(null);
  useEffect(() => {
    if (inviteCode) return;
    let alive = true;
    api
      .signupStatus()
      .then((s) => alive && setGate(s))
      .catch(() => alive && setGate({ open: true, firstAccount: false })); // na dúvida, o hub decide no envio
    return () => {
      alive = false;
    };
  }, [inviteCode]);

  if (status === "authed" && !busy) return <Navigate to={next} replace />;

  if (!inviteCode && gate && !gate.open) {
    return (
      <AuthLayout
        title="Cadastro só por convite"
        subtitle="Esta instalação do Puxibot só aceita novas pessoas por convite."
        footer={
          <>
            Já tem conta?{" "}
            <Link className="font-medium text-primary-text underline" to={paths.login}>
              Entrar
            </Link>
          </>
        }
      >
        <p className="text-sm text-muted">Peça um link de convite a quem administra o Puxibot do seu time e abra o link para criar sua conta.</p>
      </AuthLayout>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = signupSchema.safeParse({ name: name.trim(), email: email.trim(), password, inviteCode });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0]);
        if (errs[k]) continue;
        errs[k] = k === "email" ? "Digite um e-mail válido." : k === "password" ? "Use pelo menos 8 caracteres." : "Digite seu nome.";
      }
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.signup(parsed.data);
      await load();
      // Com convite, a pessoa já entra no workspace; sem convite, cria o primeiro.
      const ws = useSession.getState().workspaces;
      navigate(inviteCode && ws.length ? paths.workspace(ws[ws.length - 1]!.id) : ws.length ? next : paths.newWorkspace, { replace: true });
      // Fica "ocupado" até sair da tela: a navegação do React Router roda como transição e, com
      // busy=false, o <Navigate to={next}> acima voltaria para o convite (já usado) antes dela.
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Criar conta"
      subtitle={
        inviteCode
          ? "Crie sua conta para entrar no workspace do convite."
          : gate?.firstAccount
            ? "Você é a primeira pessoa aqui. Depois desta conta, as próximas só entram por convite."
            : "Leva um minuto. Depois você monta seu time."
      }
      footer={
        <>
          Já tem conta?{" "}
          <Link className="font-medium text-primary-text underline" to={`${paths.login}${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>
            Entrar
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Seu nome" error={errors.name}>
          {(id, d) => <Input id={id} aria-describedby={d} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} autoFocus />}
        </Field>
        <Field label="E-mail" error={errors.email}>
          {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} />}
        </Field>
        <Field label="Senha" hint="Pelo menos 8 caracteres." error={errors.password}>
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} />}
        </Field>
        <InlineError message={error} />
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Criar conta
        </Button>
      </form>
    </AuthLayout>
  );
}
