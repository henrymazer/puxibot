import type { Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import { badRequest, HttpError } from "./errors";

/** Maior corpo JSON aceito (a maior entrada legítima é a página de wiki, 200 mil caracteres). */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

const tooLarge = () => new HttpError(413, "body_too_large", "O corpo da requisição é grande demais.");

/**
 * Lê o corpo como texto com limite de bytes: recusa pelo `Content-Length` antes de ler e, sem ele
 * (corpo em stream), para de ler ao passar do limite. Nunca carrega um corpo gigante inteiro na memória.
 */
export async function readTextLimited(c: Context, limit = MAX_JSON_BYTES): Promise<string> {
  const declared = Number(c.req.header("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const stream = c.req.raw.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    all.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Lê o corpo JSON (com limite de tamanho) e valida com zod; erro vira 400 com mensagem em português. */
export async function readBody<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.output<S>> {
  const text = await readTextLimited(c);
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("Corpo da requisição não é um JSON válido.");
  }
  return parseWith(schema, raw);
}

export function parseWith<S extends ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "corpo";
    throw badRequest(`Dados inválidos em "${path}": ${translateIssue(issue?.message ?? "")}`);
  }
  return result.data as z.output<S>;
}

function translateIssue(message: string): string {
  if (/^Required$/i.test(message)) return "campo obrigatório";
  if (/Invalid email/i.test(message)) return "e-mail inválido";
  if (/at least (\d+)/i.test(message)) return `mínimo de ${message.match(/at least (\d+)/i)![1]} caracteres ou itens`;
  if (/at most (\d+)/i.test(message)) return `máximo de ${message.match(/at most (\d+)/i)![1]} caracteres ou itens`;
  if (/Expected .*, received/i.test(message)) return "tipo inválido";
  if (/Invalid enum value/i.test(message)) return "valor não permitido";
  return message;
}

/** Inteiro de query string com limites. */
export function intParam(value: string | undefined, def: number, min: number, max: number): number {
  const n = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
