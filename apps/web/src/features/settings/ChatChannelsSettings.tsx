import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Info, MessageCircle, Send } from "lucide-react";
import type { AgentDTO, ChatLinkDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWsId } from "../shell/hooks";
import { useWorkspace } from "../../store/workspace";
import { isOthersAssistant } from "../../lib/actors";
import { Badge, Button, Card, ConfirmDialog, ErrorState, Field, InlineError, LoadingState, SectionTitle, Select, Spinner } from "../../components/ui";
import { toast } from "../../components/toast";
import { CopyBox } from "./CopyBox";

type Provider = ChatLinkDTO["provider"];

const PROVIDERS: Provider[] = ["telegram", "whatsapp"];
const PROVIDER_LABEL: Record<Provider, string> = { telegram: "Telegram", whatsapp: "WhatsApp" };

const linkButtonClass =
  "inline-flex h-10 max-w-full items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover";

function emptyLink(provider: Provider): ChatLinkDTO {
  return { provider, available: false, linked: false, linkCode: null, address: null, workspaceId: null, agentId: null };
}

export function ChatChannelsSettings() {
  const ws = useWsId();
  const agentsById = useWorkspace((s) => s.agents);
  const me = useWorkspace((s) => s.me);
  const [links, setLinks] = useState<ChatLinkDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linksRef = useRef(links);
  linksRef.current = links;

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.listChatLinks(ws);
      setLinks(list);
      return list;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, [ws]);
  useEffect(() => {
    setLinks(null);
    void load();
  }, [load]);

  // Enquanto há um código na tela, confere de tempos em tempos se a pessoa já mandou.
  const waiting = !!links?.some((l) => l.available && !l.linked && !!l.linkCode);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      api
        .listChatLinks(ws)
        .then((list) => {
          for (const l of list) {
            const before = linksRef.current?.find((x) => x.provider === l.provider);
            if (l.linked && before && !before.linked) toast.success(`${PROVIDER_LABEL[l.provider]} ligado.`);
          }
          setLinks(list);
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [waiting, ws]);

  const replace = (link: ChatLinkDTO) => setLinks((prev) => (prev ? PROVIDERS.map((p) => (p === link.provider ? link : (prev.find((x) => x.provider === p) ?? emptyLink(p)))) : [link]));

  // Agentes com quem a pessoa pode conversar: sem o criador e sem assistentes de outras pessoas; o dela primeiro.
  const agents = useMemo(() => {
    const mine = (a: AgentDTO) => (a.isAssistant && a.ownerUserId === me?.userId ? 0 : 1);
    return Object.values(agentsById)
      .filter((a) => a.systemKind !== "builder" && !isOthersAssistant(a, me))
      .sort((a, b) => mine(a) - mine(b) || a.name.localeCompare(b.name, "pt-BR"));
  }, [agentsById, me]);

  return (
    <>
      <Card>
        <SectionTitle>Canais de conversa</SectionTitle>
        <p className="text-sm text-muted">
          Converse com um dos seus agentes pelo Telegram ou pelo WhatsApp. É a mesma conversa direta que você tem com ele aqui no Puxibot: o que você manda por lá
          aparece aqui, e o contrário também.
        </p>
      </Card>

      {error && !links ? (
        <Card>
          <ErrorState message={error} onRetry={() => void load()} />
        </Card>
      ) : !links ? (
        <Card>
          <LoadingState />
        </Card>
      ) : (
        PROVIDERS.map((p) => (
          <ProviderCard
            key={p}
            ws={ws}
            link={links.find((l) => l.provider === p) ?? emptyLink(p)}
            agents={agents}
            agentsById={agentsById}
            myUserId={me?.userId ?? null}
            onChange={replace}
            reload={load}
          />
        ))
      )}

      <Card>
        <SectionTitle>WhatsApp pelo seu computador (QR code)</SectionTitle>
        <p className="text-sm text-muted">
          Para uso pessoal, você pode ligar o seu próprio WhatsApp sem a API oficial: o vínculo é feito por QR code no computador onde o seu runner roda, e as
          chaves ficam só nele. No terminal desse computador:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-ink">puxibot whatsapp conectar --agente &lt;handle do agente&gt;</pre>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted">
          <li>Depois de ler o QR code, escreva na conversa “Mensagem para você mesmo” do WhatsApp. Só mensagens suas chegam ao agente; grupos e outras conversas são ignorados.</li>
          <li>Funciona com o computador ligado e o runner rodando. Se estiver desligado, a resposta fica aqui na conversa do Puxibot.</li>
          <li>
            Usa um cliente não oficial do WhatsApp: há um risco pequeno de a conta ser restringida. Serve para poucas mensagens entre você e o seu agente. Para atender
            clientes ou enviar em volume, use a API oficial (o cartão do WhatsApp acima).
          </li>
        </ul>
      </Card>

      <Card>
        <SectionTitle>Como funciona</SectionTitle>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
          <li>Só a conta que você ligou consegue falar com o agente. Mensagens de outras pessoas são ignoradas.</li>
          <li>Aprovações, logins e conexões continuam sendo feitos aqui no Puxibot, nunca no aplicativo de conversa.</li>
          <li>As respostas chegam como texto simples, sem botões nem arquivos.</li>
          <li>
            Para desligar direto pela conversa, mande <code className="font-mono text-ink">/parar</code>.
          </li>
          <li>
            No WhatsApp, o número só consegue responder até 24 horas depois da sua última mensagem. É uma regra do próprio WhatsApp: se passar disso, mande uma
            mensagem nova e a resposta chega.
          </li>
        </ul>
      </Card>
    </>
  );
}

function ProviderCard({
  ws,
  link,
  agents,
  agentsById,
  myUserId,
  onChange,
  reload,
}: {
  ws: string;
  link: ChatLinkDTO;
  agents: AgentDTO[];
  agentsById: Record<string, AgentDTO>;
  myUserId: string | null;
  onChange: (link: ChatLinkDTO) => void;
  reload: () => Promise<ChatLinkDTO[] | null>;
}) {
  const provider = link.provider;
  const label = PROVIDER_LABEL[provider];
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState<"create" | "check" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  // Mantém a escolha válida quando a lista de agentes muda.
  const selected = agents.some((a) => a.id === agentId) ? agentId : (agents[0]?.id ?? "");

  const elsewhere = !!link.workspaceId && link.workspaceId !== ws && (link.linked || !!link.linkCode);
  const waiting = !elsewhere && !link.linked && !!link.linkCode;
  const linkedHere = !elsewhere && link.linked;
  const agentName = link.agentId ? (agentsById[link.agentId]?.name ?? "um agente que não existe mais") : "um agente";

  const generate = async (forAgent: string) => {
    if (!forAgent) {
      setError("Escolha um agente.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      onChange(await api.createChatLink(ws, provider, forAgent));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setError(null);
    const list = await reload();
    setBusy(null);
    const now = list?.find((l) => l.provider === provider);
    if (now?.linked) toast.success(`${label} ligado.`);
    else if (list) toast.info("Ainda não chegou. Confira se a mensagem foi enviada e tente de novo em instantes.");
  };

  const remove = async (successText: string) => {
    setBusy("delete");
    setError(null);
    try {
      await api.deleteChatLink(ws, provider);
      setConfirmOff(false);
      toast.success(successText);
      await reload();
    } catch (e) {
      setConfirmOff(false);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const picker = (buttonLabel: string) =>
    agents.length === 0 ? (
      <Notice>Você ainda não tem um agente com quem conversar neste workspace. Crie um agente e volte aqui.</Notice>
    ) : (
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void generate(selected);
        }}
      >
        <Field label="Com qual agente você quer conversar?" className="min-w-0 flex-1">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={selected} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.isAssistant && a.ownerUserId === myUserId ? " (seu assistente)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy === "create"}>
          {buttonLabel}
        </Button>
      </form>
    );

  let body: React.ReactNode;
  if (!link.available) {
    body = (
      <Notice>
        O {label} não está ligado neste hub. Quem instalou o hub pode ligar seguindo o guia <code className="font-mono break-all text-ink">docs/deploy-cloudflare.md</code>.
      </Notice>
    );
  } else if (elsewhere) {
    body = (
      <div className="flex flex-col gap-3">
        <Notice>
          {link.linked
            ? `Seu ${label} está ligado a um agente de outro workspace.`
            : `Você começou a ligar o ${label} a um agente de outro workspace.`}{" "}
          Cada conta conversa com um agente por vez: se você ligar aqui, a ligação com o outro workspace é desfeita.
        </Notice>
        {picker("Ligar neste workspace")}
      </div>
    );
  } else if (linkedHere) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm">
          Você conversa com <strong>{agentName}</strong> pelo {label}
          {link.address ? (
            <>
              {" "}
              (<span className="break-all">{provider === "telegram" ? `@${link.address}` : link.address}</span>)
            </>
          ) : null}
          .
        </p>
        <Button variant="secondary" onClick={() => setConfirmOff(true)}>
          Desligar
        </Button>
      </div>
    );
  } else if (waiting && link.linkCode) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Falta um passo para conversar com <strong className="text-ink">{agentName}</strong>:
        </p>
        {provider === "telegram" ? <TelegramSteps code={link.linkCode} address={link.address} /> : <WhatsappSteps code={link.linkCode} address={link.address} />}
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Spinner label="Esperando" /> Esperando a sua mensagem chegar…
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === "check"} disabled={!!busy} onClick={() => void check()}>
            Já enviei
          </Button>
          <Button loading={busy === "create"} disabled={!!busy} onClick={() => void generate(link.agentId ?? selected)}>
            Gerar outro código
          </Button>
          <Button variant="ghost" loading={busy === "delete"} disabled={!!busy} onClick={() => void remove("Código cancelado.")}>
            Cancelar
          </Button>
        </div>
      </div>
    );
  } else {
    body = picker("Gerar código");
  }

  return (
    <Card>
      <SectionTitle action={linkedHere ? <Badge tone="success">Ligado</Badge> : waiting ? <Badge tone="warning">Esperando código</Badge> : undefined}>
        <span className="inline-flex items-center gap-2">
          {provider === "telegram" ? <Send className="size-4 text-muted" aria-hidden /> : <MessageCircle className="size-4 text-muted" aria-hidden />}
          {label}
        </span>
      </SectionTitle>
      {body}
      {error && (
        <div className="mt-3">
          <InlineError message={error} />
        </div>
      )}
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => void remove(`${label} desligado.`)}
        loading={busy === "delete"}
        danger
        title={`Desligar o ${label}?`}
        confirmLabel="Desligar"
        body={`${agentName} para de responder pelo ${label}. A conversa continua aqui no Puxibot, e você pode ligar de novo quando quiser.`}
      />
    </Card>
  );
}

function TelegramSteps({ code, address }: { code: string; address: string | null }) {
  return (
    <ol className="space-y-4 text-sm">
      <li>
        <p className="mb-1.5 font-medium">1. Abra o bot no Telegram</p>
        {address ? (
          <a href={`https://t.me/${encodeURIComponent(address)}?start=${encodeURIComponent(code)}`} target="_blank" rel="noopener noreferrer" className={linkButtonClass}>
            <Send className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Abrir @{address}</span>
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
        ) : (
          <p className="text-muted">Procure no Telegram o bot do Puxibot deste hub (quem instalou o hub sabe o nome).</p>
        )}
      </li>
      <li>
        <p className="mb-1.5 font-medium">2. Toque em “Iniciar”. Se não aparecer, envie esta mensagem para o bot</p>
        <CopyBox value={`/start ${code}`} label="Copiar mensagem" />
      </li>
    </ol>
  );
}

function WhatsappSteps({ code, address }: { code: string; address: string | null }) {
  const digits = address?.replace(/\D/g, "") ?? "";
  const message = `vincular ${code}`;
  return (
    <ol className="space-y-4 text-sm">
      <li>
        <p className="mb-1.5 font-medium">1. Abra uma conversa com o número do Puxibot no WhatsApp</p>
        {address ? (
          <div className="flex flex-col items-start gap-2">
            <CopyBox value={address} label="Copiar número" className="self-stretch" />
            {digits && (
              <a href={`https://wa.me/${digits}?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" className={linkButtonClass}>
                <MessageCircle className="size-4 shrink-0" aria-hidden />
                <span className="truncate">Abrir no WhatsApp</span>
                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              </a>
            )}
          </div>
        ) : (
          <p className="text-muted">Peça o número a quem instalou o hub.</p>
        )}
      </li>
      <li>
        <p className="mb-1.5 font-medium">2. Envie esta mensagem para esse número</p>
        <CopyBox value={message} label="Copiar mensagem" />
      </li>
    </ol>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm text-muted">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
