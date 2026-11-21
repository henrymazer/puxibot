import { useCallback, useEffect, useState } from "react";
import { BellRing, ExternalLink, Info, Send, Share, ShieldOff, SquarePlus } from "lucide-react";
import type { TelegramLinkDTO } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { Badge, Button, Card, InlineError, SectionTitle, Spinner, Toggle } from "../../components/ui";
import { toast } from "../../components/toast";
import { CopyBox } from "./CopyBox";
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushPermission, pushSupported, type PushPermission } from "../../pwa/push";

export function NotificationsSettings() {
  return (
    <>
      <PushCard />
      <TelegramCard />
    </>
  );
}

// ---------- Web Push ----------
type PushState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; key: string | null; subscribed: boolean; permission: PushPermission };

function PushCard() {
  const [state, setState] = useState<PushState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ios = isIos();
  const standalone = isStandalone();
  const supported = pushSupported();

  const load = useCallback(async () => {
    try {
      const key = await api.getPushPublicKey();
      const sub = supported ? await currentSubscription().catch(() => null) : null;
      setState({ kind: "ready", key, subscribed: !!sub, permission: pushPermission() });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, [supported]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (on: boolean) => {
    if (state.kind !== "ready" || !state.key) return;
    setBusy(true);
    setError(null);
    try {
      if (on) {
        await enablePush(state.key);
        toast.success("Avisos ligados neste aparelho.");
      } else {
        await disablePush();
        toast.success("Avisos desligados neste aparelho.");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      void load();
    }
  };

  let body: React.ReactNode;
  if (state.kind === "loading") body = <Spinner label="Carregando" />;
  else if (state.kind === "error") body = <InlineError message={state.message} />;
  else if (!state.key) {
    body = (
      <Notice icon={<ShieldOff className="size-4" />}>
        Os avisos no aparelho estão desligados neste hub. Para ligar, quem administra o hub precisa configurar as chaves de Web Push (VAPID). Enquanto isso, as
        notificações continuam aparecendo no sininho dentro do Puxibot.
      </Notice>
    );
  } else if (!supported) {
    body =
      ios && !standalone ? null : (
        <Notice icon={<Info className="size-4" />}>Este navegador não recebe avisos. Tente pelo Chrome, Edge, Firefox ou Safari atualizado.</Notice>
      );
  } else {
    const denied = state.permission === "denied";
    body = (
      <div className="flex flex-col gap-3">
        <Toggle
          label="Receber avisos neste aparelho"
          description={state.subscribed ? "Ligado. Você recebe um aviso quando alguém menciona você, pede aprovação ou um agente para com erro." : "Desligado neste aparelho."}
          checked={state.subscribed}
          onChange={(v) => void toggle(v)}
          disabled={busy || denied}
          disabledReason={denied ? "O navegador está bloqueando avisos deste site." : undefined}
        />
        {denied && (
          <Notice icon={<Info className="size-4" />}>
            Para desbloquear: no computador, clique no cadeado ao lado do endereço, abra <strong>Notificações</strong> e escolha <strong>Permitir</strong>. No celular,
            abra os ajustes do navegador (ou do app Puxibot) e libere as notificações. Depois volte aqui e ligue de novo.
          </Notice>
        )}
        <InlineError message={error} />
      </div>
    );
  }

  return (
    <Card>
      <SectionTitle>Avisos neste aparelho</SectionTitle>
      <p className="mb-4 text-sm text-muted">
        Vale só para este navegador. O aviso nunca traz o conteúdo das mensagens: diz que há novidade e abre a tela certa quando você toca nele.
      </p>
      {body}
      {ios && !standalone && state.kind === "ready" && !!state.key && <IosHelp />}
    </Card>
  );
}

function IosHelp() {
  return (
    <div className="mt-4 rounded-md border border-line bg-surface-2 p-3 text-sm">
      <p className="mb-2 flex items-center gap-2 font-medium">
        <BellRing className="size-4 text-primary" aria-hidden />
        No iPhone e no iPad
      </p>
      <p className="mb-2 text-muted">O iOS só entrega avisos quando o Puxibot está na tela de início. Leva um minuto:</p>
      <ol className="list-decimal space-y-1.5 pl-5 text-muted">
        <li>
          Abra esta página no Safari e toque em <Share className="inline size-4 align-text-bottom" aria-label="Compartilhar" /> <strong className="text-ink">Compartilhar</strong>.
        </li>
        <li>
          Escolha <SquarePlus className="inline size-4 align-text-bottom" aria-hidden /> <strong className="text-ink">Adicionar à Tela de Início</strong>.
        </li>
        <li>Abra o Puxibot pelo ícone novo e volte a esta tela para ligar os avisos.</li>
      </ol>
    </div>
  );
}

function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm text-muted">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </p>
  );
}

// ---------- Telegram ----------
function TelegramCard() {
  const [link, setLink] = useState<TelegramLinkDTO | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLink(await api.getTelegramLink());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Enquanto o código está na tela, confere de tempos em tempos se a pessoa já abriu o bot.
  const waiting = !!link && !link.linked;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      api
        .getTelegramLink()
        .then((l) => {
          if (l?.linked) toast.success("Telegram vinculado.");
          setLink(l);
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [waiting]);

  // 404: o hub não tem bot do Telegram configurado — a seção some.
  if (link === null) return null;

  const run = async (fn: () => Promise<TelegramLinkDTO | void>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r) setLink(r);
      else await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const botUrl = link && link.linkCode ? `https://t.me/${link.botUsername}?start=${encodeURIComponent(link.linkCode)}` : null;

  return (
    <Card>
      <SectionTitle action={link?.linked ? <Badge tone="success">Vinculado</Badge> : undefined}>Telegram</SectionTitle>
      <p className="mb-4 text-sm text-muted">
        Receba avisos curtos no Telegram, como “Tito respondeu em #dev”, com o link para abrir. O conteúdo das mensagens nunca vai para o Telegram.
      </p>
      {link === undefined && !error && <Spinner label="Carregando" />}
      <InlineError message={error} />
      {link?.linked && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            Avisos chegando em <strong>@{link.botUsername}</strong>.
          </p>
          <Button variant="secondary" loading={busy} onClick={() => void run(() => api.deleteTelegramLink())}>
            Desvincular
          </Button>
        </div>
      )}
      {link && !link.linked && (
        <ol className="space-y-4 text-sm">
          <li>
            <p className="mb-1.5 font-medium">1. Abra o bot no Telegram</p>
            {botUrl ? (
              <a
                href={botUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
              >
                <Send className="size-4" aria-hidden />
                Abrir @{link.botUsername}
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : (
              <Button variant="primary" loading={busy} onClick={() => void run(() => api.createTelegramLink())}>
                Gerar código
              </Button>
            )}
          </li>
          {link.linkCode && (
            <li>
              <p className="mb-1.5 font-medium">2. Toque em “Iniciar”, ou mande esta mensagem para o bot</p>
              <CopyBox value={`/start ${link.linkCode}`} label="Copiar mensagem" />
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Spinner label="Esperando" /> Esperando o Telegram confirmar…
                </span>
                <button type="button" className="min-h-8 underline hover:text-ink" disabled={busy} onClick={() => void run(() => api.createTelegramLink())}>
                  Gerar outro código
                </button>
              </p>
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}
