import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { createAppointment, toApi, type AppointmentRow } from "../lib/appointments";
import { verifyPassword } from "../lib/crypto";
import { HttpError, parseQuery, readJson } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { loadRange, loadSettings, resolveRange, saveSettings } from "../lib/schedule";
import { addDays, bogotaNow, diffDays, isValidDate, TIME_RE } from "../lib/time";
import {
  adminCreateAppointmentSchema,
  dayOverrideSchema,
  loginSchema,
  rangeQuerySchema,
  settingsSchema,
  slotOverrideSchema,
  updateStatusSchema,
} from "../lib/validation";
import { createSession, destroySession, hasValidSession, requireAdmin } from "../middleware/auth";

export const adminRoutes = new Hono<AppEnv>();

const ID_RE = /^[0-9a-f-]{36}$/;

function limited(rl: { retryAfter: number }, message: string): never {
  throw new HttpError(429, "rate_limited", message, undefined, { "Retry-After": String(rl.retryAfter) });
}

// ---------- Sesión ----------

adminRoutes.post("/login", async (c) => {
  const ip = c.get("clientIp");
  const [perIp, global] = await Promise.all([
    rateLimit(c.env.DB, "login-ip", ip, 5, 900),
    rateLimit(c.env.DB, "login-all", "all", 40, 3600),
  ]);
  if (!perIp.ok || !global.ok) limited(perIp.ok ? global : perIp, "Demasiados intentos. Espera unos minutos.");

  const { password } = await readJson(c, loginSchema);
  const ok = await verifyPassword(password, c.env.ADMIN_PASSWORD_HASH);
  if (!ok) throw new HttpError(401, "invalid_credentials", "Clave incorrecta");

  await createSession(c);
  return c.json({ ok: true });
});

adminRoutes.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

adminRoutes.get("/me", async (c) => c.json({ authenticated: await hasValidSession(c) }));

// Todo lo demás exige sesión.
adminRoutes.use("*", async (c, next) => {
  if (c.req.path.endsWith("/login") || c.req.path.endsWith("/logout") || c.req.path.endsWith("/me")) return next();
  return requireAdmin(c, next);
});

adminRoutes.use("*", async (c, next) => {
  if (c.req.path.endsWith("/login")) return next();
  const rl = await rateLimit(c.env.DB, "admin", c.get("clientIp"), 300, 60);
  if (!rl.ok) limited(rl, "Demasiadas peticiones");
  return next();
});

// ---------- Resumen ----------

adminRoutes.get("/summary", async (c) => {
  const today = bogotaNow().date;
  const week = addDays(today, 7);
  const rows = await c.env.DB.batch<{ n: number }>([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM appointments WHERE date = ?1").bind(today),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'pendiente' AND date >= ?1").bind(today),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM appointments WHERE date > ?1 AND date <= ?2").bind(today, week),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'atendida'"),
  ]);
  const n = (i: number) => rows[i]?.results[0]?.n ?? 0;
  return c.json({ today, todayTotal: n(0), pendingUpcoming: n(1), nextSevenDays: n(2), attendedTotal: n(3) });
});

// ---------- Citas ----------

const listQuery = z.object({
  from: z.string().refine(isValidDate).optional(),
  to: z.string().refine(isValidDate).optional(),
  status: z.enum(["pendiente", "atendida"]).optional(),
  q: z.string().max(80).optional(),
});

adminRoutes.get("/appointments", async (c) => {
  const q = parseQuery(c, listQuery);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (q.from) (where.push("date >= ?"), binds.push(q.from));
  if (q.to) (where.push("date <= ?"), binds.push(q.to));
  if (q.status) (where.push("status = ?"), binds.push(q.status));
  if (q.q && q.q.trim()) {
    const like = `%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(client_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR service_name LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  const sql = `SELECT * FROM appointments ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date ASC, time ASC LIMIT 500`;
  const res = await c.env.DB.prepare(sql).bind(...binds).all<AppointmentRow>();
  return c.json({ appointments: res.results.map(toApi) });
});

adminRoutes.post("/appointments", async (c) => {
  const body = await readJson(c, adminCreateAppointmentSchema);
  const row = await createAppointment(c.env.DB, body, { source: "admin" });
  return c.json({ appointment: toApi(row) }, 201);
});

adminRoutes.patch("/appointments/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) throw new HttpError(404, "not_found", "Cita no encontrada");
  const { status } = await readJson(c, updateStatusSchema);
  const row = await c.env.DB.prepare("UPDATE appointments SET status = ?1, updated_at = ?2 WHERE id = ?3 RETURNING *")
    .bind(status, new Date().toISOString(), id)
    .first<AppointmentRow>();
  if (!row) throw new HttpError(404, "not_found", "Cita no encontrada");
  return c.json({ appointment: toApi(row) });
});

adminRoutes.delete("/appointments/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) throw new HttpError(404, "not_found", "Cita no encontrada");
  const res = await c.env.DB.prepare("DELETE FROM appointments WHERE id = ?1").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "not_found", "Cita no encontrada");
  return c.json({ ok: true });
});

// ---------- Agenda ----------

adminRoutes.get("/schedule", async (c) => {
  const q = parseQuery(c, rangeQuerySchema);
  if (q.to < q.from || diffDays(q.from, q.to) > 62) {
    throw new HttpError(400, "validation_error", "Rango de fechas inválido", { to: "Rango de fechas inválido" });
  }
  const [settings, data, appts] = await Promise.all([
    loadSettings(c.env.DB),
    loadRange(c.env.DB, q.from, q.to),
    c.env.DB.prepare("SELECT * FROM appointments WHERE date BETWEEN ?1 AND ?2").bind(q.from, q.to).all<AppointmentRow>(),
  ]);
  const byKey = new Map(appts.results.map((a) => [`${a.date} ${a.time}`, a]));
  const days = resolveRange(q.from, q.to, settings, data).map((d) => ({
    ...d,
    slots: d.slots.map((s) => {
      const a = byKey.get(`${d.date} ${s.time}`);
      return a ? { ...s, appointment: toApi(a) } : s;
    }),
  }));
  return c.json({ today: bogotaNow().date, settings, days });
});

adminRoutes.put("/days/:date", async (c) => {
  const date = c.req.param("date");
  if (!isValidDate(date)) throw new HttpError(400, "validation_error", "Fecha inválida");
  const { open, note } = await readJson(c, dayOverrideSchema);
  await c.env.DB.prepare(
    "INSERT INTO day_overrides (date, is_open, note) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET is_open = ?2, note = ?3",
  )
    .bind(date, open ? 1 : 0, note)
    .run();
  const affected = open
    ? 0
    : ((await c.env.DB.prepare("SELECT COUNT(*) AS n FROM appointments WHERE date = ?1 AND status = 'pendiente'").bind(date).first<{ n: number }>())?.n ?? 0);
  return c.json({ ok: true, pendingAppointmentsOnDay: affected });
});

adminRoutes.delete("/days/:date", async (c) => {
  const date = c.req.param("date");
  if (!isValidDate(date)) throw new HttpError(400, "validation_error", "Fecha inválida");
  await c.env.DB.prepare("DELETE FROM day_overrides WHERE date = ?1").bind(date).run();
  return c.json({ ok: true });
});

adminRoutes.put("/slots/:date/:time", async (c) => {
  const { date, time } = c.req.param();
  if (!isValidDate(date) || !TIME_RE.test(time)) throw new HttpError(400, "validation_error", "Fecha u hora inválida");
  const { open } = await readJson(c, slotOverrideSchema);
  await c.env.DB.prepare(
    "INSERT INTO slot_overrides (date, time, is_open) VALUES (?1, ?2, ?3) ON CONFLICT(date, time) DO UPDATE SET is_open = ?3",
  )
    .bind(date, time, open ? 1 : 0)
    .run();
  return c.json({ ok: true });
});

adminRoutes.delete("/slots/:date/:time", async (c) => {
  const { date, time } = c.req.param();
  if (!isValidDate(date) || !TIME_RE.test(time)) throw new HttpError(400, "validation_error", "Fecha u hora inválida");
  await c.env.DB.prepare("DELETE FROM slot_overrides WHERE date = ?1 AND time = ?2").bind(date, time).run();
  return c.json({ ok: true });
});

// ---------- Configuración general ----------

adminRoutes.get("/settings", async (c) => c.json({ settings: await loadSettings(c.env.DB) }));

adminRoutes.put("/settings", async (c) => {
  const body = await readJson(c, settingsSchema);
  await saveSettings(c.env.DB, body);
  return c.json({ settings: body });
});
