import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2, TriangleAlert } from "lucide-react";
import type { ApiTokenDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWsId } from "../shell/hooks";
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, InlineError, Input, LoadingState, SectionTitle, Select } from "../../components/ui";
import { toast } from "../../components/toast";
import { formatDateTime, formatRelative } from "../../lib/format";
import { CopyBox } from "./CopyBox";

const KIND_LABEL: Record<ApiTokenDTO["kind"], string> = { personal: "Pessoal", runner: "Computador" };

export function TokensSettings() {
  const ws = useWsId();
  const [tokens, setTokens] = useState<ApiTokenDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ApiTokenDTO["kind"]>("personal");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [revoke, setRevoke] = useState<ApiTokenDTO | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTokens((await api.listTokens(ws)).sort((a, b) => b.createdAt - a.createdAt));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [ws]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) {
      setCreateError("Dê um nome para lembrar onde o token é usado.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const { token } = await api.createToken(ws, { name: name.trim(), kind });
      setCreated({ name: name.trim(), token });
      setName("");
      void load();
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const doRevoke = async () => {
    if (!revoke) return;
    setRevoking(true);
    try {
      await api.deleteToken(ws, revoke.id);
      setTokens((t) => t?.filter((x) => x.id !== revoke.id) ?? null);
      toast.success("Token revogado.");
      setRevoke(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <Card>
        <SectionTitle>Criar token</SectionTitle>
        <p className="mb-3 text-sm text-muted">
          Tokens deixam scripts e outros apps (como Claude ou Cursor, pelo servidor MCP) agirem com as suas permissões neste workspace.
        </p>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label="Nome" className="flex-1">
            {(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Script de relatórios" maxLength={80} />}
          </Field>
          <Field label="Tipo" className="sm:w-44">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ApiTokenDTO["kind"])}>
                <option value="personal">Pessoal</option>
                <option value="runner">Computador (runner)</option>
              </Select>
            )}
          </Field>
          <Button type="submit" variant="primary" loading={creating}>
            Criar
          </Button>
        </form>
        <div className="mt-2">
          <InlineError message={createError} />
        </div>
        {created && (
          <div role="status" className="mt-4 rounded-md border border-agent-line bg-agent-soft p-3">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium text-agent">
              <TriangleAlert className="size-4" aria-hidden />
              Copie agora, ele não aparece de novo.
            </p>
            <p className="mb-2 text-xs text-muted">Token “{created.name}”. Guarde num lugar seguro.</p>
            <CopyBox value={created.token} label="Copiar token" className="bg-surface" />
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Já copiei
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Seus tokens</SectionTitle>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : !tokens ? (
          <LoadingState />
        ) : tokens.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-5" />} title="Nenhum token">
            Crie um token acima quando precisar.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2.5">
                <KeyRound className="size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <Badge>{KIND_LABEL[t.kind] ?? t.kind}</Badge>
                  </div>
                  <p className="text-xs text-subtle">
                    Criado em {formatDateTime(t.createdAt)} · {t.lastUsedAt ? `usado ${formatRelative(t.lastUsedAt)}` : "nunca usado"}
                  </p>
                </div>
                <IconButton label={`Revogar ${t.name}`} onClick={() => setRevoke(t)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!revoke}
        onClose={() => setRevoke(null)}
        onConfirm={() => void doRevoke()}
        loading={revoking}
        danger
        title="Revogar token?"
        confirmLabel="Revogar"
        body={`Tudo que usa “${revoke?.name ?? ""}” para de funcionar na hora.`}
      />
    </>
  );
}
