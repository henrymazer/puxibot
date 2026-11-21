import type { MessageCard } from "@puxibot/shared";
import { CheckSquare, Square } from "lucide-react";
import { Link } from "react-router-dom";
import { safeLink } from "../../lib/safeLink";

/** Cartões ricos dentro da mensagem (barras, tabela, checklist, estatísticas). */
export function MessageCards({ cards }: { cards: MessageCard[] }) {
  if (!cards.length) return null;
  return (
    <div className="mt-2 flex max-w-2xl flex-col gap-2">
      {cards.map((c, i) => (
        <CardView key={i} card={c} />
      ))}
    </div>
  );
}

function Frame({ title, subtitle, children }: { title?: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <figure className="overflow-hidden rounded-lg border border-line bg-surface">
      {(title || subtitle) && (
        <figcaption className="border-b border-line px-3.5 py-2">
          {title && <div className="text-sm font-semibold">{title}</div>}
          {subtitle && <div className="text-xs text-muted">{subtitle}</div>}
        </figcaption>
      )}
      <div className="px-3.5 py-3">{children}</div>
    </figure>
  );
}

function CardView({ card }: { card: MessageCard }) {
  switch (card.type) {
    case "bars": {
      const max = Math.max(1, ...card.rows.map((r) => r.value));
      return (
        <Frame title={card.title} subtitle={card.subtitle}>
          <ul className="flex flex-col gap-2">
            {card.rows.map((r, i) => (
              <li key={i} className="grid grid-cols-[minmax(4rem,8rem)_1fr_4.5rem] items-center gap-3 text-sm">
                <span className="truncate text-muted">{r.label}</span>
                <span className="h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
                </span>
                <span className="text-right font-medium tabular-nums">{r.display ?? r.value.toLocaleString("pt-BR")}</span>
              </li>
            ))}
          </ul>
        </Frame>
      );
    }
    case "table":
      return (
        <Frame title={card.title}>
          <div className="tb-scroll -mx-3.5 -my-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-2">
                  {card.columns.map((c, i) => (
                    <th key={i} scope="col" className="px-3.5 py-2 text-left font-semibold whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {r.map((cell, j) => (
                      <td key={j} className="px-3.5 py-2 align-top">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Frame>
      );
    case "checklist": {
      const done = card.items.filter((i) => i.done).length;
      return (
        <Frame title={card.title} subtitle={`${done} de ${card.items.length} feitos`}>
          <ul className="flex flex-col gap-1.5">
            {card.items.map((it, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {it.done ? <CheckSquare className="mt-0.5 size-4 shrink-0 text-success" aria-label="Feito" /> : <Square className="mt-0.5 size-4 shrink-0 text-subtle" aria-label="A fazer" />}
                <ChecklistLabel label={it.label} link={it.link} done={!!it.done} />
              </li>
            ))}
          </ul>
        </Frame>
      );
    }
    case "stats":
      return (
        <Frame title={card.title}>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {card.items.map((it, i) => (
              <div key={i} className="rounded-md bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">{it.label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{it.value}</dd>
              </div>
            ))}
          </dl>
        </Frame>
      );
    default:
      return null;
  }
}

/** O link do item só vira `href` se for http(s) ou caminho da interface (lib/safeLink); senão, texto. */
function ChecklistLabel({ label, link, done }: { label: string; link?: string | null; done: boolean }) {
  const safe = safeLink(link);
  const cls = done ? "text-muted line-through" : "text-primary-text underline";
  if (!safe) return <span className={done ? "text-muted line-through" : ""}>{label}</span>;
  if (safe.kind === "internal") {
    return (
      <Link to={safe.href} className={cls}>
        {label}
      </Link>
    );
  }
  return (
    <a href={safe.href} target="_blank" rel="noopener noreferrer nofollow" className={cls}>
      {label}
    </a>
  );
}
