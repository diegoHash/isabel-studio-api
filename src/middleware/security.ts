import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "../env";
import { safeEqual } from "../lib/crypto";
import { HttpError } from "../lib/http";

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

/** Cabeceras de seguridad para respuestas JSON de la API. */
export const securityHeaders: MiddlewareHandler<AppEnv> = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  crossOriginResourcePolicy: "same-site",
});

/** Nunca cachear respuestas de la API (datos personales y disponibilidad en vivo). */
export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

/**
 * Solo el proxy de Vercel (que conoce PROXY_SECRET) puede llamar a la API.
 * Esto evita que alguien salte el proxy y su validación de origen, y permite
 * confiar en la IP real del visitante que reenvía el proxy para el rate limit.
 */
export const proxyGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = c.env.PROXY_SECRET;
  const isProd = c.env.ENVIRONMENT === "production";

  if (!secret) {
    if (isProd) throw new HttpError(500, "misconfigured", "Servicio no disponible");
    c.set("clientIp", c.req.header("cf-connecting-ip") ?? "local");
    return next();
  }

  const provided = c.req.header("x-proxy-secret") ?? "";
  if (!(await safeEqual(provided, secret))) throw new HttpError(403, "forbidden", "Acceso denegado");

  const forwarded = (c.req.header("x-client-ip") ?? "").trim();
  c.set("clientIp", IP_RE.test(forwarded) ? forwarded : "unknown");
  return next();
};

/** Protección CSRF: las peticiones que modifican datos deben venir de un origen autorizado. */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

  const allowed = (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const origin = (c.req.header("origin") ?? "").replace(/\/$/, "");
  if (!origin || !allowed.includes(origin)) {
    throw new HttpError(403, "bad_origin", "Origen no autorizado");
  }
  return next();
};
