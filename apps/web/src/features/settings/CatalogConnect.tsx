/**
 * Catálogo de apps com conexão pronta e o diálogo que guia cada conexão: mostra para que serve, o que
 * precisa e o que não faz, e pede só o que falta (um token, ou o login no site do serviço).
 * Usado em Configurações › Conectores e na tela do agente criador, depois de criar a estrutura.
 */
import { useEffect, useState } from "react";
import { ExternalLink, Plug } from "lucide-react";
import type { CatalogApp, ConnectorAuthMethod, ConnectorDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { Badge, Button, Field, InlineError, Input, Modal } from "../../components/ui";
import { toast } from "../../components/toast";
import { Segmented } from "../agents/shared";
import { CopyBox } from "./CopyBox";

const RETURN_KEY = "puxibot-oauth-volta";

/** Para onde voltar depois do login no site do serviço (a tela do criador, por exemplo). */
export function rememberOAuthReturn(path: string | null): void {
  try {
    if (path) sessionStorage.setItem(RETURN_KEY, path);
    else sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* sem armazenamento: volta para a tela de conectores */
  }
}
export function takeOAuthReturn(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return v && v.startsWith("/w/") ? v : null;
  } catch {
    return null;
  }
}

/** Pede ao hub o endereço da tela de consentimento e manda o navegador para lá. */
export async function startConnectorLogin(ws: string, connectorId: string, returnTo: string | null = null): Promise<void> {
  const { url } = await api.startConnectorOAuth(ws, connectorId);
  // Só segue para um endereço HTTPS: o hub já confere, e a interface confere de novo.
  if (!/^https:\/\//i.test(url)) throw new Error("O hub devolveu um endereço de login inválido.");
  rememberOAuthReturn(returnTo);
  location.assign(url);
}

const METHOD_LABEL: Record<ConnectorAuthMethod, string> = { oauth2: "Entrar pelo site", bearer: "Colar um token", "x-api-key": "Colar uma chave" };

export function useCatalog(ws: string): { apps: CatalogApp[] | null; callbackUrl: string; error: string | null } {
  const [state, setState] = useState<{ apps: CatalogApp[] | null; callbackUrl: string; error: string | null }>({ apps: null, callbackUrl: "", error: null });
  useEffect(() => {
    let alive = true;
    api
      .getCatalog(ws)
      .then((c) => alive && setState({ apps: c.items, callbackUrl: c.callbackUrl, error: null }))
      .catch((e) => alive && setState({ apps: [], callbackUrl: "", error: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [ws]);
  return state;
}

/** Cartões dos apps do catálogo. `connected`: ids de catálogo que a pessoa já conectou. */
export function CatalogGrid({ apps, connected, onPick }: { apps: CatalogApp[]; connected: Set<string>; onPick: (app: CatalogApp) => void }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {apps.map((app) => (
        <li key={app.id} className="flex flex-col rounded-md border border-line p-3">
          <div className="flex items-start gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
              <Plug className="size-4.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{app.displayName}</p>
              <p className="text-xs text-subtle">{app.categories.join(" · ")}</p>
            </div>
            {connected.has(app.id) && <Badge tone="success">Conectado</Badge>}
          </div>
          <p className="mt-2 flex-1 text-sm text-muted">{app.description}</p>
          <div className="mt-3">
            <Button size="sm" variant={connected.has(app.id) ? "secondary" : "primary"} onClick={() => onPick(app)}>
              {connected.has(app.id) ? "Conectar outra conta" : "Conectar"}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CatalogConnectDialog({
  ws,
  app,
  callbackUrl,
  grantAgentIds = [],
  grantNames = [],
  returnTo = null,
  onClose,
  onConnected,
}: {
  ws: string;
  app: CatalogApp;
  callbackUrl: string;
  /** Agentes que recebem acesso assim que a conexão for criada. */
  grantAgentIds?: string[];
  grantNames?: string[];
  /** Para onde voltar depois do login pelo site (padrão: Configurações › Conectores). */
  returnTo?: string | null;
  onClose: () => void;
  onConnected: (c: ConnectorDTO) => void;
}) {
  const [method, setMethod] = useState<ConnectorAuthMethod>(app.authentication[0]!);
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauth = method === "oauth2";

  const submit = async () => {
    if (!oauth && !token.trim()) return setError("Cole o token para continuar.");
    if (oauth && app.clientIdRequired && !clientId.trim()) return setError("Informe o ID do seu app.");
    setBusy(true);
    setError(null);
    try {
      const created = await api.connectFromCatalog(ws, {
        catalogId: app.id,
        method,
        ...(oauth ? (clientId.trim() ? { clientId: clientId.trim() } : {}) : { token: token.trim() }),
        grantAgentIds,
      });
      // O token sai da tela assim que foi enviado.
      setToken("");
      onConnected(created);
      if (oauth) {
        // Daqui o navegador vai para o site do serviço e volta com o login feito.
        await startConnectorLogin(ws, created.id, returnTo);
        return;
      }
      toast.success(`${app.displayName} conectado.`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Conectar ${app.displayName}`}
      description={app.description}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {oauth ? `Continuar para ${app.displayName}` : "Conectar"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <section>
          <h3 className="text-sm font-medium">O que dá para pedir</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
            {app.prompts.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
        <div className="grid gap-4 sm:grid-cols-2">
          <section>
            <h3 className="text-sm font-medium">Você precisa de</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
              {app.requirements.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="text-sm font-medium">Limites</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
              {app.limitations.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
        </div>

        {app.authentication.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Como conectar</span>
            <Segmented label="Forma de conexão" value={method} onChange={setMethod} options={app.authentication.map((m) => ({ id: m, label: METHOD_LABEL[m] }))} />
          </div>
        )}

        {oauth ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Você será levado ao site do {app.displayName} para entrar e escolher o que liberar. O Puxibot guarda o acesso cifrado no hub e o renova sozinho; nenhuma senha passa por aqui.
            </p>
            {app.clientIdRequired && (
              <>
                <Field label="ID do seu app" hint={app.hints.clientId}>
                  {(id, d) => <Input id={id} aria-describedby={d} value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} autoComplete="off" className="font-mono" />}
                </Field>
                {callbackUrl && (
                  <div>
                    <p className="mb-1 text-sm font-medium">Endereço de retorno</p>
                    <p className="mb-1.5 text-xs text-muted">Cadastre este endereço no seu app como URL de redirecionamento válida.</p>
                    <CopyBox value={callbackUrl} />
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <Field label={method === "bearer" ? "Token de acesso" : "Chave de API"} hint={app.hints.token}>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono"
                placeholder="Cole aqui"
              />
            )}
          </Field>
        )}

        <p className="text-xs text-muted">
          {grantNames.length
            ? `Ao conectar, ${grantNames.join(", ")} ${grantNames.length > 1 ? "passam" : "passa"} a usar este serviço. `
            : "Depois de conectar, libere o acesso no perfil de cada agente. "}
          Consultas rodam direto; qualquer ação que altere algo passa pela checagem de permissão e pode pedir a sua aprovação.
          {!oauth && " O token fica cifrado no hub e nunca mais aparece na tela."}
        </p>
        {app.homepage && (
          <a href={app.homepage} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary-text hover:underline">
            Documentação do serviço <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
        <InlineError message={error} />
      </div>
    </Modal>
  );
}
