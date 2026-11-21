import { useSearchParams } from "react-router-dom";
import { Laptop } from "lucide-react";
import { PageHeader } from "../shell/PageHeader";
import { Card } from "../../components/ui";
import { PairForm } from "./PairForm";

export function PairPage() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? params.get("codigo") ?? "";
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <PageHeader title="Parear computador" icon={<Laptop className="size-5" />} />
      <div className="tb-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl space-y-4 px-4 py-6 md:px-6">
          <Card>
            <h2 className="mb-1 text-base font-semibold">Ligar este computador ao workspace</h2>
            <p className="mb-4 text-sm text-muted">
              Confira se o código abaixo é o mesmo que aparece no terminal do computador. Ao aprovar, ele passa a executar agentes
              usando a CLI de IA e a assinatura de quem está logado nele.
            </p>
            <PairForm initialCode={code} showComputersLink />
          </Card>
          <p className="text-xs text-subtle">Não reconhece este pedido? Não aprove. O código expira sozinho.</p>
        </div>
      </div>
    </div>
  );
}
