/**
 * Pequenos helpers sobre D1. Sempre com prepared statements e bind; nunca concatenar entrada em SQL.
 * Para listas variáveis em `IN (...)`, use `placeholders(n)` (gera só "?" — os valores vão no bind).
 */
export type SqlValue = string | number | null;

export async function first<T>(db: D1Database, sql: string, ...params: SqlValue[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function all<T>(db: D1Database, sql: string, ...params: SqlValue[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results;
}

/** Executa e devolve quantas linhas mudaram. */
export async function run(db: D1Database, sql: string, ...params: SqlValue[]): Promise<number> {
  const res = await db.prepare(sql).bind(...params).run();
  return res.meta.changes ?? 0;
}

export function stmt(db: D1Database, sql: string, ...params: SqlValue[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

export function placeholders(n: number): string {
  if (n <= 0) throw new Error("placeholders(n) com n <= 0");
  return new Array(n).fill("?").join(",");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
