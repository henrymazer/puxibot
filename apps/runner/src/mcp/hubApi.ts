/**
 * Cliente HTTP da API de ferramentas do hub (`/api/tool/*`), autenticado com o
 * token do job. Usa node:http(s) direto para não ter limite de tempo nas
 * chamadas longas (`consultar_agente` espera a resposta de outro agente).
 */
import http from "node:http";
import https from "node:https";

export interface HubResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  multipart?: { fields: Record<string, string>; file?: { field: string; name: string; mime: string; data: Buffer } };
  timeoutMs?: number;
}

export class HubApi {
  constructor(
    readonly hubUrl: string,
    private readonly token: string,
  ) {}

  request(opts: RequestOptions): Promise<HubResponse> {
    const url = new URL(this.hubUrl);
    url.pathname = url.pathname.replace(/\/$/, "") + opts.path;
    url.search = "";
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
    let body: Buffer | undefined;
    if (opts.multipart) {
      const boundary = `----puxibot${Math.random().toString(16).slice(2)}`;
      const parts: Buffer[] = [];
      for (const [k, v] of Object.entries(opts.multipart.fields)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      }
      const f = opts.multipart.file;
      if (f) {
        const safeName = f.name.replace(/["\r\n]/g, "_");
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${safeName}"\r\nContent-Type: ${f.mime}\r\n\r\n`,
          ),
          f.data,
          Buffer.from("\r\n"),
        );
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      body = Buffer.concat(parts);
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    } else if (opts.json !== undefined) {
      body = Buffer.from(JSON.stringify(opts.json));
      headers["Content-Type"] = "application/json";
    }
    if (body) headers["Content-Length"] = String(body.length);
    const lib = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method: opts.method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("tempo esgotado esperando o hub")));
      if (body) req.write(body);
      req.end();
    });
  }

  /** Requisição que espera JSON; erros viram HubApiError com a mensagem do hub. */
  async json<T = unknown>(opts: RequestOptions): Promise<T> {
    const res = await this.request(opts);
    const text = res.body.toString("utf8");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status >= 200 && res.status < 300) return data as T;
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new HubApiError(res.status, err?.code ?? null, err?.message ?? (typeof data === "string" && data ? data.slice(0, 300) : `HTTP ${res.status}`));
  }
}
