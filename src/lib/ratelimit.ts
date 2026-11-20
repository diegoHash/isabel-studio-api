import { sha256Hex } from "./crypto";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number; // segundos
}

/**
 * Rate limit de ventana fija respaldado por D1 (operación atómica con UPSERT).
 * La clave se hashea para no almacenar IPs ni teléfonos en claro.
 */
export async function rateLimit(
  db: D1Database,
  scope: string,
  identity: string,
  limit: number,
  windowSeconds: number,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const key = `${scope}:${(await sha256Hex(identity)).slice(0, 32)}`;
  const windowMs = windowSeconds * 1000;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
       RETURNING count, window_start`,
    )
    .bind(key, nowMs, nowMs - windowMs)
    .first<{ count: number; window_start: number }>();

  const count = row?.count ?? 1;
  const windowStart = row?.window_start ?? nowMs;
  const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfter };
}
