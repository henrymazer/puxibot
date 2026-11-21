/**
 * Links vindos de dados (tarefas, cartões de mensagem escritos por agentes) só viram `href`
 * quando são `http(s)://` absolutos ou caminhos relativos da própria interface (`/w/...`).
 * Qualquer outra coisa (`javascript:`, `data:`, `//outro-site`, `/\outro-site`, texto solto) vira texto.
 */
export type SafeLink = { kind: "external"; href: string } | { kind: "internal"; href: string };

export function safeLink(raw: unknown): SafeLink | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  // Espaço, caractere de controle e barra invertida mudam como o navegador lê o endereço.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (value.startsWith("/")) {
    if (value.startsWith("//")) return null; // relativo ao protocolo = outro site
    return { kind: "internal", href: value };
  }
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const u = new URL(value);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
    return { kind: "external", href: value };
  } catch {
    return null;
  }
}
