import type { ApiError } from "@puxibot/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Erro de API com mensagem em português. Lançar em qualquer camada; o handler do app formata como `ApiError`. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "invalid_input") => new HttpError(400, code, message);
export const unauthorized = (message = "Faça login para continuar.") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Você não tem permissão para fazer isso.", code = "forbidden") =>
  new HttpError(403, code, message);
export const notFound = (message = "Não encontrado.") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

export function errorBody(code: string, message: string): ApiError {
  return { error: { code, message } };
}
