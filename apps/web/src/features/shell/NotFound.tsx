import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { EmptyState } from "../../components/ui";

export function NotFound() {
  return (
    <div className="flex h-full flex-1 items-center justify-center">
      <EmptyState icon={<Compass className="size-5" />} title="Página não encontrada">
        <p>
          Esse endereço não existe ou você não tem acesso. <Link to="/" className="text-primary-text underline">Voltar ao início</Link>
        </p>
      </EmptyState>
    </div>
  );
}
