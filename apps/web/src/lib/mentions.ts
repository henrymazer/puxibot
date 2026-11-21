/** Autocomplete de @menções no campo de mensagem. */

export interface MentionQuery {
  /** Texto depois do @ até o cursor. */
  query: string;
  /** Índice do @ no texto. */
  start: number;
}

const HANDLE_CHAR = /[a-z0-9_\-À-ÿ.]/i;

/** Detecta se o cursor está logo depois de um "@algo" que ainda está sendo digitado. */
export function getMentionQuery(text: string, caret: number): MentionQuery | null {
  let i = caret - 1;
  while (i >= 0 && HANDLE_CHAR.test(text[i]!)) i--;
  if (i < 0 || text[i] !== "@") return null;
  const before = i > 0 ? text[i - 1]! : "";
  if (before && !/[\s([{"'>]/.test(before)) return null; // e-mail, por exemplo
  const query = text.slice(i + 1, caret);
  if (query.length > 32) return null;
  return { query, start: i };
}

export interface MentionCandidate {
  type: "user" | "agent";
  id: string;
  handle: string;
  name: string;
  detail?: string | null;
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Ordena: handle começa com a busca, nome começa, palavra do nome começa, contém. Agentes antes no empate. */
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const q = normalize(query);
  const scored: { c: MentionCandidate; score: number }[] = [];
  for (const c of candidates) {
    const handle = normalize(c.handle);
    const name = normalize(c.name);
    let score = -1;
    if (q === "") score = 1;
    else if (handle.startsWith(q)) score = 4;
    else if (name.startsWith(q)) score = 3;
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
    else if (handle.includes(q) || name.includes(q)) score = 1;
    if (score >= 0) scored.push({ c, score: score * 10 + (c.type === "agent" ? 1 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name, "pt-BR"));
  return scored.slice(0, limit).map((s) => s.c);
}

/** Troca o "@consulta" pelo handle completo e devolve a nova posição do cursor. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  caret: number,
  handle: string,
): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = `@${handle}${after.startsWith(" ") ? "" : " "}`;
  const next = text.slice(0, mention.start) + insert + after;
  return { text: next, caret: mention.start + insert.length };
}
