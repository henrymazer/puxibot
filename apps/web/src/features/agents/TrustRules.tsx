import { useEffect, useId, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { BROWSER_TOOL, type AgentDTO, type ConnectorDTO, type TrustRuleDTO } from "@puxibot/shared";
import { api, ApiClientError, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { Badge, Button, ErrorState, IconButton, InlineError, Input, Select, Spinner } from "../../components/ui";
import { useWsId } from "../shell/hooks";

type Effect = TrustRuleDTO["effect"];
const EFFECTS: { id: Effect; label: string; tone: "success" | "warning" | "danger" }[] = [
  { id: "allow", label: "Permitir sempre", tone: "success" },
  { id: "ask", label: "Perguntar antes", tone: "warning" },
  { id: "deny", label: "Proibir", tone: "danger" },
];
const effectOf = (e: Effect) => EFFECTS.find((x) => x.id === e) ?? EFFECTS[1]!;

/** Regras por serviço: o que o agente faz sempre, só perguntando, ou nunca. Só o responsável e admins veem. */
export function TrustRules({ agent, connectors }: { agent: AgentDTO; connectors: ConnectorDTO[] | null }) {
  const ws = useWsId();
  const uid = useId();
  const me = useWorkspace((s) => s.me);
  const members = useWorkspace((s) => s.members);
  const [rules, setRules] = useState<TrustRuleDTO[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [service, setService] = useState("");
  const [tool, setTool] = useState("");
  const [effect, setEffect] = useState<Effect>("ask");

  const load = () => {
    setLoadError(null);
    api
      .listTrustRules(ws, agent.id)
      .then(setRules)
      .catch((e) => {
        // Sem permissão (ou hub antigo, sem regras): a seção some.
        if (e instanceof ApiClientError && (e.status === 403 || e.status === 404 || e.status === 501)) setHidden(true);
        else setLoadError(errorMessage(e));
      });
  };
  useEffect(load, [ws, agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOwner = agent.ownerUserId === me?.userId;
  const browserOn = agent.toolPerms[BROWSER_TOOL] === "write";
  const byId = useMemo(() => new Map((connectors ?? []).map((c) => [c.id, c])), [connectors]);
  const serviceName = (id: string) => (id === BROWSER_TOOL ? "Navegador" : (byId.get(id)?.name ?? "Serviço removido"));

  /** Serviços a que o agente tem acesso hoje. */
  const services = useMemo(() => {
    const list = (connectors ?? []).filter((c) => (agent.toolPerms[`connector:${c.id}`] ?? "none") !== "none").map((c) => ({ id: c.id, name: c.name }));
    if (browserOn) list.push({ id: BROWSER_TOOL, name: "Navegador" });
    return list;
  }, [connectors, agent.toolPerms, browserOn]);
  const selected = services.some((s) => s.id === service) ? service : (services[0]?.id ?? "");

  const groups = useMemo(() => {
    const map = new Map<string, TrustRuleDTO[]>();
    for (const r of rules ?? []) map.set(r.connectorId, [...(map.get(r.connectorId) ?? []), r]);
    return [...map.entries()]
      .map(([id, list]) => ({ id, name: serviceName(id), list: list.sort((a, b) => (a.tool === "*" ? -1 : b.tool === "*" ? 1 : a.tool.localeCompare(b.tool))) }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules, byId]);

  if (hidden) return null;

  /** "Permitir sempre" só vale vindo de quem conectou o serviço (ou do responsável, no navegador). */
  const allowOwner =
    effect !== "allow" || !selected
      ? null
      : selected === BROWSER_TOOL
        ? isOwner
          ? null
          : (members[agent.ownerUserId]?.name ?? "o responsável pelo agente")
        : byId.get(selected)?.ownerUserId === me?.userId
          ? null
          : (members[byId.get(selected)?.ownerUserId ?? ""]?.name ?? "quem conectou o serviço");

  const add = async () => {
    if (!selected) return;
    setBusy("add");
    setError(null);
    try {
      const saved = await api.setTrustRule(ws, agent.id, { connectorId: selected, tool: tool.trim() || "*", effect });
      setRules((l) => {
        const rest = (l ?? []).filter((r) => r.id !== saved.id && !(r.connectorId === saved.connectorId && r.tool === saved.tool));
        return [...rest, saved];
      });
      setTool("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (r: TrustRuleDTO) => {
    setBusy(r.id);
    setError(null);
    try {
      await api.deleteTrustRule(ws, agent.id, r.id);
      setRules((l) => (l ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby={`${uid}-title`}>
      <h3 id={`${uid}-title`} className="mb-1 text-sm font-semibold">
        Regras
      </h3>
      <p className="mb-2 text-xs text-muted">Valem sempre para este agente, seja qual for o pedido. Uma regra de uma ação específica vale mais que a de “qualquer ação”.</p>

      {loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : rules === null ? (
        <Spinner />
      ) : (
        <>
          {groups.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-muted">Nenhuma regra ainda.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((g) => (
                <div key={g.id}>
                  <h4 className="mb-1 text-xs font-semibold text-muted">{g.name}</h4>
                  <ul className="divide-y divide-line rounded-lg border border-line bg-surface" aria-label={`Regras de ${g.name}`}>
                    {g.list.map((r) => {
                      const ef = effectOf(r.effect);
                      const what = r.tool === "*" ? "qualquer ação" : r.tool;
                      return (
                        <li key={r.id} className="flex items-center gap-2 px-3 py-2 md:px-4">
                          <span className={r.tool === "*" ? "min-w-0 flex-1 text-sm" : "min-w-0 flex-1 font-mono text-sm break-all"}>{what}</span>
                          <Badge tone={ef.tone} className="shrink-0">
                            {ef.label}
                          </Badge>
                          <IconButton size="sm" label={`Apagar regra de ${g.name}: ${what}`} disabled={busy !== null} onClick={() => void remove(r)} className="shrink-0 hover:text-danger">
                            {busy === r.id ? <Spinner label="Apagando" /> : <Trash2 className="size-4" />}
                          </IconButton>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-subtle">As regras criadas ao responder “Sempre” em um pedido de aprovação também aparecem aqui.</p>

          {services.length === 0 ? (
            <p className="mt-3 text-xs text-muted">Para criar uma regra, dê primeiro ao agente acesso a um conector ou ligue o navegador.</p>
          ) : (
            <form
              className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <span className="text-sm font-medium">Nova regra</span>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={`${uid}-service`} className="text-xs text-muted">
                    Serviço
                  </label>
                  <Select id={`${uid}-service`} value={selected} onChange={(e) => setService(e.target.value)}>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={`${uid}-tool`} className="text-xs text-muted">
                    Ação (nome da ferramenta)
                  </label>
                  <Input id={`${uid}-tool`} value={tool} onChange={(e) => setTool(e.target.value)} placeholder="todas" maxLength={120} spellCheck={false} autoCapitalize="off" />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={`${uid}-effect`} className="text-xs text-muted">
                    O que fazer
                  </label>
                  <Select id={`${uid}-effect`} value={effect} onChange={(e) => setEffect(e.target.value as Effect)}>
                    {EFFECTS.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              {allowOwner && (
                <p className="text-xs text-muted">
                  “Permitir sempre” neste serviço só pode ser criada por {allowOwner}. Você pode criar “Perguntar antes” ou “Proibir”.
                </p>
              )}
              <div className="flex justify-end">
                <Button size="sm" variant="primary" type="submit" loading={busy === "add"} disabled={busy !== null && busy !== "add"}>
                  Adicionar regra
                </Button>
              </div>
            </form>
          )}
          <div className="mt-2">
            <InlineError message={error} />
          </div>
        </>
      )}
    </section>
  );
}
