import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "../../components/ui";
import { cn } from "../../lib/cn";

/** Texto em fonte mono com botão de copiar. Quebra linha em vez de criar rolagem na página. */
export function CopyBox({ value, label = "Copiar", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* sem permissão de área de transferência: a pessoa pode selecionar o texto */
    }
  };
  return (
    <div className={cn("flex items-start gap-1 rounded-md border border-line bg-surface-2 py-1 pr-1 pl-3", className)}>
      <code className="min-w-0 flex-1 py-1.5 font-mono text-sm break-all select-all">{value}</code>
      <IconButton label={copied ? "Copiado" : label} size="sm" onClick={() => void copy()}>
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </IconButton>
    </div>
  );
}
