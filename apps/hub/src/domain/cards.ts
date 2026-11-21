import { z } from "zod";
import type { MessageCard } from "@puxibot/shared";

/**
 * Link que a interface pode transformar em `<a href>`: só `http(s)://` ou caminho relativo do próprio app
 * (`/w/...`). Recusa `javascript:`, `data:`, `vbscript:`, `//outro-host` etc.
 */
export function isSafeLink(raw: string): boolean {
  const s = raw.trim();
  if (s.startsWith("/")) return !s.startsWith("//") && !s.startsWith("/\\");
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export const safeLinkSchema = z
  .string()
  .max(2000)
  .refine(isSafeLink, "link inválido: use http(s):// ou um caminho do app");

export const safeUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((s) => /^https?:\/\//i.test(s.trim()), "link inválido: use http:// ou https://");

/** Cartões ricos (`MessageCard`) com limites de tamanho e links seguros. */
export const cardSchema = z.union([
  z.object({
    type: z.literal("bars"),
    title: z.string().max(200),
    subtitle: z.string().max(300).optional(),
    rows: z.array(z.object({ label: z.string().max(200), value: z.number(), display: z.string().max(50).optional() })).max(50),
  }),
  z.object({
    type: z.literal("table"),
    title: z.string().max(200).optional(),
    columns: z.array(z.string().max(100)).max(20),
    rows: z.array(z.array(z.string().max(1000)).max(20)).max(100),
  }),
  z.object({
    type: z.literal("checklist"),
    title: z.string().max(200),
    items: z.array(z.object({ label: z.string().max(500), done: z.boolean(), link: safeLinkSchema.optional() })).max(50),
  }),
  z.object({
    type: z.literal("stats"),
    title: z.string().max(200).optional(),
    items: z.array(z.object({ label: z.string().max(100), value: z.string().max(100) })).max(12),
  }),
]);

export const cardsSchema = z.array(cardSchema).max(5);

/** Cartões vindos do runner (`job.done`): os inválidos são descartados, um a um. */
export function sanitizeCards(raw: unknown): MessageCard[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageCard[] = [];
  for (const item of raw.slice(0, 5)) {
    const parsed = cardSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data as MessageCard);
  }
  return out;
}
