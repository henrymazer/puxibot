import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Info, LockKeyhole, Pencil, Plus, Trash2 } from "lucide-react";
import type { VaultItemDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWsId } from "../shell/hooks";
import { useWorkspace } from "../../store/workspace";
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, InlineError, Input, LoadingState, Modal, SectionTitle } from "../../components/ui";
import { toast } from "../../components/toast";
import { formatRelative } from "../../lib/format";

/** Compara o que a pessoa digitou com a origem guardada, sem depender de "https://" ou barra no fim. */
function sameSite(typed: string, origin: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^https:\/\//, "")
      .replace(/\/+$/, "");
  return norm(typed) === norm(origin);
}

function siteLabel(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

export function VaultSettings() {
  const ws = useWsId();
  const agents = useWorkspace((s) => s.agents);
  const [items, setItems] = useState<VaultItemDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `null` = fechado; "new" = adicionando; item = editando.
  const [form, setForm] = useState<VaultItemDTO | "new" | null>(null);
  const [remove, setRemove] = useState<VaultItemDTO | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await api.listVault(ws)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [ws]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const doRemove = async () => {
    if (!remove) return;
    setRemoving(true);
    try {
      await api.deleteVaultItem(ws, remove.id);
      setItems((list) => list?.filter((x) => x.id !== remove.id) ?? null);
      toast.success("Login apagado.");
      setRemove(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setRemoving(false);
    }
  };

  const anyBrowser = Object.values(agents).some((a) => a.toolPerms["browser"] === "write");

  return (
    <>
      <Card>
        <SectionTitle>Cofre</SectionTitle>
        <div className="space-y-2 text-sm text-muted">
          <p>
            Aqui ficam os logins de sites que o navegador de um agente pode usar. O agente nunca vê a senha: é o Puxibot que digita no site na hora de entrar.
          </p>
          <p>
            Só você vê os seus logins, nem os administradores têm acesso. Um login só é usado quando o agente está trabalhando para você, no seu computador e numa
            página daquele mesmo site. Cada uso passa pela checagem de permissão, então pode ser que o Puxibot peça a sua aprovação antes.
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle
          action={
            items && items.length > 0 ? (
              <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setForm("new")}>
                Adicionar login
              </Button>
            ) : undefined
          }
        >
          Seus logins
        </SectionTitle>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : !items ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<LockKeyhole className="size-5" />}
            title="Nenhum login guardado"
            action={
              <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setForm("new")}>
                Adicionar login
              </Button>
            }
          >
            Guarde o login de um site para um agente entrar nele por você.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-2 py-2.5">
                <LockKeyhole className="size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{it.name}</p>
                  <p className="text-xs break-all text-muted">
                    {siteLabel(it.origin)} · {it.username}
                  </p>
                  <p className="text-xs text-subtle">{it.lastUsedAt ? `Usado pela última vez ${formatRelative(it.lastUsedAt)}` : "Nunca usado"}</p>
                </div>
                <IconButton label={`Editar ${it.name}`} onClick={() => setForm(it)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton label={`Apagar ${it.name}`} onClick={() => setRemove(it)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!anyBrowser && (
        <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm text-muted">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0">
            Nenhum agente deste workspace está com o navegador ligado, e os logins só são usados por agentes com o navegador ligado. Para ligar, abra o perfil do
            agente, aba “Ferramentas e acesso”. O navegador também precisa estar habilitado no runner do seu computador:{" "}
            <code className="font-mono break-all text-ink">{'"browser": { "enabled": true }'}</code> no arquivo <code className="font-mono text-ink">config.json</code>{" "}
            do runner.
          </span>
        </p>
      )}

      {form && (
        <VaultForm
          key={form === "new" ? "new" : form.id}
          ws={ws}
          item={form === "new" ? null : form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(null)}
        onConfirm={() => void doRemove()}
        loading={removing}
        danger
        title="Apagar login?"
        confirmLabel="Apagar"
        body={`Os agentes deixam de conseguir entrar em ${remove ? siteLabel(remove.origin) : "este site"} com “${remove?.name ?? ""}”. A senha guardada é apagada.`}
      />
    </>
  );
}

function VaultForm({ ws, item, onClose, onSaved }: { ws: string; item: VaultItemDTO | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!item;
  const [name, setName] = useState(item?.name ?? "");
  const [site, setSite] = useState(item ? siteLabel(item.origin) : "");
  const [username, setUsername] = useState(item?.username ?? "");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const siteChanged = !!item && !!site.trim() && !sameSite(site, item.origin);
  const passwordRequired = !editing || siteChanged;

  const nameError = tried && !name.trim() ? "Dê um nome para reconhecer este login." : null;
  const siteError =
    tried && !site.trim() ? "Informe o site." : /^\s*http:\/\//i.test(site) ? "O site precisa usar endereço seguro (https)." : null;
  const usernameError = tried && !username.trim() ? "Informe o usuário ou e-mail." : null;
  const passwordError =
    tried && passwordRequired && !password
      ? siteChanged
        ? "Digite a senha de novo para trocar o site."
        : "Informe a senha."
      : null;

  const submit = async () => {
    setTried(true);
    setError(null);
    if (!name.trim() || !site.trim() || /^\s*http:\/\//i.test(site) || !username.trim() || (passwordRequired && !password)) return;
    setSaving(true);
    try {
      if (item) {
        const patch: { name?: string; site?: string; username?: string; password?: string } = {};
        if (name.trim() !== item.name) patch.name = name.trim();
        if (siteChanged) patch.site = site.trim();
        if (username.trim() !== item.username) patch.username = username.trim();
        if (password) patch.password = password;
        if (Object.keys(patch).length > 0) await api.updateVaultItem(ws, item.id, patch);
      } else {
        await api.createVaultItem(ws, { name: name.trim(), site: site.trim(), username: username.trim(), password });
      }
      // A senha digitada não fica na memória da tela depois de salvar.
      setPassword("");
      setShow(false);
      toast.success(item ? "Login atualizado." : "Login guardado no cofre.");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    setPassword("");
    onClose();
  };

  return (
    <Modal
      open
      onClose={close}
      title={editing ? "Editar login" : "Adicionar login"}
      description="A senha fica guardada cifrada e nunca é mostrada de novo, nem para você."
      footer={
        <>
          <Button onClick={close}>Cancelar</Button>
          <Button type="submit" form="vault-form" variant="primary" loading={saving}>
            {editing ? "Salvar" : "Guardar login"}
          </Button>
        </>
      }
    >
      <form
        id="vault-form"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Nome" error={nameError}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} aria-invalid={!!nameError} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Painel de relatórios" maxLength={80} data-autofocus />
          )}
        </Field>
        <Field label="Site" hint="O endereço do site, como app.exemplo.com. O login só é usado em páginas desse site." error={siteError}>
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              aria-invalid={!!siteError}
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="app.exemplo.com"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Usuário ou e-mail" error={usernameError}>
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              aria-invalid={!!usernameError}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
            />
          )}
        </Field>
        <Field
          label="Senha"
          hint={
            !editing
              ? undefined
              : siteChanged
                ? "Você mudou o site. Por segurança, digite a senha de novo: a senha guardada não é levada para outro site."
                : "Deixe em branco para manter a senha atual."
          }
          error={passwordError}
        >
          {(id, d) => (
            <div className="flex items-center gap-1">
              <Input
                id={id}
                aria-describedby={d}
                aria-invalid={!!passwordError}
                aria-required={passwordRequired}
                className="min-w-0 flex-1"
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <IconButton label={show ? "Esconder senha" : "Mostrar senha"} aria-pressed={show} onClick={() => setShow((v) => !v)}>
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </IconButton>
            </div>
          )}
        </Field>
        <InlineError message={error} />
      </form>
    </Modal>
  );
}
