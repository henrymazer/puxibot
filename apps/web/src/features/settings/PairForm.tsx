import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { paths } from "../../lib/paths";
import { Button, Field, InlineError, Input } from "../../components/ui";
import { useWsId } from "../shell/hooks";

/** Aprova o pareamento de um computador digitando o código mostrado pelo runner. */
export function PairForm({ initialCode = "", onPaired, showComputersLink }: { initialCode?: string; onPaired?: () => void; showComputersLink?: boolean }) {
  const ws = useWsId();
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pairedName, setPairedName] = useState<string | null>(null);

  const submit = async () => {
    const c = code.trim().toUpperCase();
    if (!c) {
      setError("Digite o código que apareceu no computador.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.approvePairing(ws, c);
      setPairedName(res.name);
      setDone(true);
      // O hub também manda `runner.updated`; recarregar garante a lista certa.
      api
        .listRunners(ws)
        .then((runners) => {
          const dispatch = useWorkspace.getState().dispatch;
          for (const r of runners) dispatch({ type: "runner.updated", runner: r });
        })
        .catch(() => undefined);
      onPaired?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div role="status" className="flex flex-col items-start gap-3 rounded-md bg-success-soft p-4">
        <p className="flex items-center gap-2 font-medium text-success">
          <CheckCircle2 className="size-5" aria-hidden />
          {pairedName ? <>Computador “{pairedName}” pareado</> : "Computador pareado"}
        </p>
        <p className="text-sm text-muted">
          Em alguns segundos ele aparece como ligado e já pode executar agentes. Se esse não é o nome do seu computador, remova-o em Configurações › Computadores.
        </p>
        <div className="flex flex-wrap gap-2">
          {showComputersLink && (
            <Link to={paths.settings(ws, "computadores")} className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover">
              Ver computadores
            </Link>
          )}
          <Button
            onClick={() => {
              setDone(false);
              setPairedName(null);
              setCode("");
            }}
          >
            Parear outro
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
    <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-ink">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <span>
        Só aprove um código que você mesmo gerou agora no seu computador. Aprovar o código de outra pessoa liga o computador dela à sua conta: ele passaria a
        receber os seus pedidos aos agentes, com o conteúdo das suas conversas.
      </span>
    </p>
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Código de pareamento" hint="Aparece no terminal do computador. Vale por 10 minutos." className="flex-1">
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Ex.: ABCD-1234"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono tracking-wider uppercase"
          />
        )}
      </Field>
      <Button type="submit" variant="primary" loading={busy} className="sm:mb-[22px]">
        Aprovar
      </Button>
    </form>
    <InlineError message={error} />
    </div>
  );
}
