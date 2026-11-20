import type { Context } from "hono";
import type { ZodType, z } from "zod";
import { formatZodError } from "./validation";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 10_000;

export async function readJson<T extends ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type debe ser application/json");
  }
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Petición demasiado grande");
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Petición demasiado grande");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "JSON inválido");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, "validation_error", "Revisa los datos ingresados", formatZodError(result.error));
  }
  return result.data;
}

export function parseQuery<T extends ZodType>(c: Context, schema: T): z.output<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new HttpError(400, "validation_error", "Parámetros inválidos", formatZodError(result.error));
  }
  return result.data;
}
