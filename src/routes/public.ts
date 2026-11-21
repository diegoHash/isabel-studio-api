import { Hono } from "hono";
import type { AppEnv } from "../env";
import { createAppointment, toApi } from "../lib/appointments";
import { HttpError, parseQuery, readJson } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { isPublished } from "../middleware/auth";
import { bookingWindow, loadRange, loadSettings, resolveRange } from "../lib/schedule";
import { SERVICES } from "../lib/services";
import { TIMEZONE, diffDays } from "../lib/time";
import { createAppointmentSchema, rangeQuerySchema } from "../lib/validation";

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/health", (c) => c.json({ ok: true }));

/** Estado de publicación: el sitio muestra la marca de agua "Maqueta" mientras sea false. */
publicRoutes.get("/status", async (c) => c.json({ published: await isPublished(c.env.DB) }));

publicRoutes.get("/services", (c) => c.json({ services: SERVICES }));

publicRoutes.get("/availability", async (c) => {
  const rl = await rateLimit(c.env.DB, "availability", c.get("clientIp"), 120, 60);
  if (!rl.ok) throw new HttpError(429, "rate_limited", "Demasiadas consultas, intenta en un momento", undefined, { "Retry-After": String(rl.retryAfter) });

  const q = parseQuery(c, rangeQuerySchema);
  const w = bookingWindow();
  // Se recorta al rango reservable para no exponer ni calcular de más.
  const from = q.from < w.from ? w.from : q.from;
  const to = q.to > w.to ? w.to : q.to;
  if (to < from || diffDays(from, to) > 62) {
    throw new HttpError(400, "validation_error", "Rango de fechas inválido", { to: "Rango de fechas inválido" });
  }

  const [settings, data] = await Promise.all([loadSettings(c.env.DB), loadRange(c.env.DB, from, to)]);
  const days = resolveRange(from, to, settings, data).map((d) => ({
    date: d.date,
    open: d.open,
    reason: d.reason,
    holiday: d.holiday,
    slots: d.slots.filter((s) => s.state === "available").map((s) => s.time),
  }));
  return c.json({ timezone: TIMEZONE, window: w, days });
});

publicRoutes.post("/appointments", async (c) => {
  const ip = c.get("clientIp");
  const hourly = await rateLimit(c.env.DB, "book-ip", ip, 6, 3600);
  if (!hourly.ok) {
    throw new HttpError(429, "rate_limited", "Demasiados intentos. Intenta de nuevo más tarde.", undefined, { "Retry-After": String(hourly.retryAfter) });
  }

  const body = await readJson(c, createAppointmentSchema);

  // Honeypot: se responde "éxito" para no darle pistas al bot, pero no se guarda nada.
  if (body.website && body.website.trim() !== "") {
    return c.json({ appointment: { id: crypto.randomUUID(), status: "pendiente" } }, 201);
  }

  const perPhone = await rateLimit(c.env.DB, "book-phone", body.phone, 4, 86_400);
  if (!perPhone.ok) {
    throw new HttpError(429, "rate_limited", "Este número ya hizo varias reservas hoy.", undefined, { "Retry-After": String(perPhone.retryAfter) });
  }

  const { website: _ignored, ...input } = body;
  const row = await createAppointment(c.env.DB, input, { source: "web" });
  return c.json({ appointment: toApi(row) }, 201);
});
