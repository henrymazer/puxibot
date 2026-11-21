import { useEffect, useState } from "react";
import { KeyRound, Pencil, Plug, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import type { ConnectorDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import type { ConnectorInput } from "../../api/client";
import { useWorkspace } from "../../store/workspace";
import { PersonAvatar } from "../../components/Avatar";
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, InlineError, Input, LoadingState, LockedNote, Modal, SectionTitle, Textarea } from "../../components/ui";
import { toast } from "../../components/toast";
import { Segmented } from "../agents/shared";
import { isAdmin } from "../../lib/actors";
import { useWsId } from "../shell/hooks";

export function ConnectorsSettings() {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const [items, setItems] = useState<ConnectorDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ConnectorDTO | "new" | null>(null);
  const [deleting, setDeleting] = useState<ConnectorDTO | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    api
      .listConnectors(ws)
      .then((l) => setItems(l.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))))
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, [ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // O hub só deixa o dono mudar; admins podem remover.
  const canEdit = (c: ConnectorDTO) => c.ownerUserId === me?.userId;
  const canDelete = (c: ConnectorDTO) => c.ownerUserId === me?.userId || isAdmin(me?.role);
  const usedBy = (id: string) => Object.values(agents).filter((a) => (a.toolPerms[`connector:${id}`] ?? "none") !== "none");

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteConnector(ws, deleting.id);
      setItems((l) => l?.filter((x) => x.id !== deleting.id) ?? null);
      toast.success("Conector removido.");
      setDeleting(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <SectionTitle
          action={
            <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              Novo conector
            </Button>
          }
        >
          Conectores
        </SectionTitle>
        <p className="mb-4 text-sm text-muted">
          Servidores MCP que dão aos agentes acesso a GitHub, e-mail e outros serviços. Cada conector tem um dono: só ele concede acesso aos agentes
          (no perfil do agente, “Ferramentas e acesso”). Chaves e senhas ficam guardadas cifradas no hub e só são entregues ao computador que
          executa o agente.
        </p>
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : items === null ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <EmptyState icon={<Plug className="size-5" />} title="Nenhum conector ainda">
            Conecte um servidor MCP para os agentes usarem.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {items.map((c) => {
              const owner = members[c.ownerUserId];
              const mine = c.ownerUserId === me?.userId;
              const users = usedBy(c.id);
              const secretNames = [...(c.secretHeaderNames ?? []), ...(c.secretEnvNames ?? [])];
              return (
                <li key={c.id} className="rounded-md border border-line p-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                      <Plug className="size-4.5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium break-words">{c.name}</span>
                        <Badge>{c.transport === "http" ? "HTTP" : "Comando local"}</Badge>
                      </div>
                      <p className="mt-0.5 font-mono text-xs break-all text-muted">{c.transport === "http" ? c.url : [c.command, ...c.args].join(" ")}</p>
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                        <PersonAvatar member={owner} name={owner?.name ?? "?"} size="xs" />
                        Dono: {mine ? "você" : (owner?.name ?? "pessoa removida")}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        {c.hasSecrets ? (
                          <>
                            <span className="inline-flex items-center gap-1 text-success">
                              <ShieldCheck className="size-3.5" aria-hidden /> Segredos configurados
                            </span>
                            {secretNames.map((n) => (
                              <code key={n} className="rounded-xs bg-surface-2 px-1 font-mono text-[11px] text-muted">
                                {n}
                              </code>
                            ))}
                          </>
                        ) : (
                          <span className="text-subtle">Sem segredos</span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-subtle">{users.length ? `Liberado para ${users.map((a) => a.name).join(", ")}` : "Nenhum agente tem acesso ainda"}</p>
                    </div>
                    {canEdit(c) && (
                      <IconButton label={`Editar ${c.name}`} onClick={() => setEditing(c)}>
                        <Pencil className="size-4" />
                      </IconButton>
                    )}
                    {canDelete(c) && (
                      <IconButton label={`Remover ${c.name}`} onClick={() => setDeleting(c)} className="hover:text-danger">
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                  {!canEdit(c) && <LockedNote>Só {owner?.name ?? "o dono"} muda este conector e concede acesso a ele.{canDelete(c) ? " Como admin, você pode removê-lo." : ""}</LockedNote>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {editing && (
        <ConnectorDialog
          connector={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => setItems((l) => (l ? (l.some((x) => x.id === c.id) ? l.map((x) => (x.id === c.id ? c : x)) : [...l, c]) : [c]))}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        loading={busy}
        danger
        title={`Remover "${deleting?.name}"?`}
        body="Os agentes perdem o acesso a este serviço e os segredos guardados são apagados."
        confirmLabel="Remover"
      />
    </>
  );
}

interface SecretRow {
  key: string;
  value: string;
}

/** Pares nome/valor de segredos. Valores são só de escrita. */
function SecretsEditor({ label, hint, rows, onChange, namePlaceholder }: { label: string; hint: string; rows: SecretRow[]; onChange: (r: SecretRow[]) => void; namePlaceholder: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      <p className="-mt-1 text-xs text-muted">{hint}</p>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input aria-label={`Nome ${i + 1}`} value={r.key} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder={namePlaceholder} className="w-2/5 font-mono text-sm" autoComplete="off" spellCheck={false} />
          <Input
            aria-label={`Valor de ${r.key || `segredo ${i + 1}`}`}
            type="password"
            value={r.value}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            placeholder="Valor"
            className="min-w-0 flex-1 font-mono text-sm"
            autoComplete="new-password"
          />
          <IconButton label="Tirar" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X className="size-4" />
          </IconButton>
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => onChange([...rows, { key: "", value: "" }])}>
          Adicionar
        </Button>
      </div>
    </fieldset>
  );
}

function toMap(rows: SecretRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim() && r.value) out[r.key.trim()] = r.value;
  return out;
}

function ConnectorDialog({ connector, onClose, onSaved }: { connector?: ConnectorDTO; onClose: () => void; onSaved: (c: ConnectorDTO) => void }) {
  const ws = useWsId();
  const [name, setName] = useState(connector?.name ?? "");
  const [transport, setTransport] = useState<"http" | "stdio">(connector?.transport ?? "http");
  const [url, setUrl] = useState(connector?.url ?? "");
  const [command, setCommand] = useState(connector?.command ?? "");
  const [args, setArgs] = useState((connector?.args ?? []).join("\n"));
  // Novo conector: editor aberto. Existente: segredos ficam como estão até a pessoa pedir para trocar.
  const [replacing, setReplacing] = useState(!connector);
  const [headers, setHeaders] = useState<SecretRow[]>(() => (connector?.secretHeaderNames ?? []).map((key) => ({ key, value: "" })));
  const [env, setEnv] = useState<SecretRow[]>(() => (connector?.secretEnvNames ?? []).map((key) => ({ key, value: "" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secretNames = [...(connector?.secretHeaderNames ?? []), ...(connector?.secretEnvNames ?? [])];

  const submit = async () => {
    if (!name.trim()) return setError("Dê um nome ao conector.");
    if (transport === "http" && !/^https?:\/\//.test(url.trim())) return setError("Informe o endereço do servidor MCP, começando com https://");
    if (transport === "stdio" && !command.trim()) return setError("Informe o comando que inicia o servidor MCP.");
    const emptyValues = replacing && [...headers, ...env].some((r) => r.key.trim() && !r.value);
    if (emptyValues) return setError("Preencha o valor de cada segredo, ou tire a linha.");
    setBusy(true);
    setError(null);
    try {
      const input: ConnectorInput = {
        name: name.trim(),
        transport,
        url: transport === "http" ? url.trim() : null,
        command: transport === "stdio" ? command.trim() : null,
        args: transport === "stdio" ? args.split(/\n/).map((a) => a.trim()).filter(Boolean) : [],
      };
      if (replacing) {
        input.headers = transport === "http" ? toMap(headers) : {};
        input.env = toMap(env);
      }
      const saved = connector ? await api.updateConnector(ws, connector.id, input) : await api.createConnector(ws, input);
      onSaved(saved);
      toast.success(connector ? "Conector salvo." : "Conector criado. Agora libere o acesso no perfil de cada agente.");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={connector ? `Editar ${connector.name}` : "Novo conector"}
      description={connector ? undefined : "Você vira o dono: só você concede acesso a ele para os agentes."}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {connector ? "Salvar" : "Criar conector"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Nome">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Ex.: GitHub do time" data-autofocus />}</Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Como conectar</span>
          <Segmented
            label="Tipo de conector"
            value={transport}
            onChange={setTransport}
            options={[
              { id: "http", label: "Endereço (HTTP)" },
              { id: "stdio", label: "Comando local" },
            ]}
          />
        </div>
        {transport === "http" ? (
          <Field label="Endereço do servidor MCP">{(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="https://…/mcp" spellCheck={false} />}</Field>
        ) : (
          <>
            <Field label="Comando" hint="Roda no computador de quem executa o agente.">
              {(id, d) => <Input id={id} aria-describedby={d} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" spellCheck={false} />}
            </Field>
            <Field label="Argumentos" hint="Um por linha.">
              {(id, d) => <Textarea id={id} aria-describedby={d} value={args} onChange={(e) => setArgs(e.target.value)} className="min-h-20 font-mono text-sm" spellCheck={false} placeholder={"-y\n@exemplo/servidor-mcp"} />}
            </Field>
          </>
        )}

        <div className="rounded-md border border-line p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <KeyRound className="size-4 text-muted" aria-hidden /> Segredos
          </p>
          <p className="mt-0.5 text-xs text-muted">Depois de salvos, os valores nunca mais aparecem aqui, nem para você.</p>
          {!replacing ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {connector?.hasSecrets ? (
                <>
                  <Badge tone="success">Configurado</Badge>
                  {secretNames.map((n) => (
                    <code key={n} className="rounded-xs bg-surface-2 px-1 font-mono text-xs text-muted">
                      {n}
                    </code>
                  ))}
                </>
              ) : (
                <span className="text-sm text-subtle">Nenhum segredo guardado.</span>
              )}
              <Button size="sm" onClick={() => setReplacing(true)} className="ml-auto">
                {connector?.hasSecrets ? "Substituir segredos" : "Adicionar segredos"}
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-4">
              {connector?.hasSecrets && <p className="rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">Os segredos atuais serão trocados pelos que você preencher aqui. Linhas sem valor são descartadas.</p>}
              {transport === "http" && (
                <SecretsEditor label="Cabeçalhos" hint="Ex.: Authorization com o valor Bearer …" rows={headers} onChange={setHeaders} namePlaceholder="Authorization" />
              )}
              <SecretsEditor label="Variáveis de ambiente" hint={transport === "stdio" ? "Passadas ao comando, ex.: GITHUB_TOKEN." : "Opcional."} rows={env} onChange={setEnv} namePlaceholder="API_KEY" />
              {connector && (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
                    Manter os segredos atuais
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
