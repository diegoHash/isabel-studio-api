import { randomId } from "./crypto";
import { HttpError } from "./http";
import { bookingWindow, isWithinBookingWindow, loadRange, loadSettings, resolveDay } from "./schedule";
import { findService } from "./services";
import { bogotaNow } from "./time";

export interface AppointmentInput {
  serviceIds: string[];
  date: string;
  time: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
}

export interface AppointmentRow {
  id: string;
  service_id: string;
  service_name: string;
  services_json: string | null;
  total: number;
  client_name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  date: string;
  time: string;
  status: "pendiente" | "atendida";
  source: "web" | "admin";
  created_at: string;
  updated_at: string;
}

export const MAX_PENDING_PER_PHONE = 3;

export interface ApptService {
  id: string;
  name: string;
  price: number | null;
}

function parseServices(r: AppointmentRow): ApptService[] {
  try {
    const parsed = r.services_json ? JSON.parse(r.services_json) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* se usa el respaldo */
  }
  return [{ id: r.service_id, name: r.service_name, price: null }];
}

export function toApi(r: AppointmentRow) {
  const services = parseServices(r);
  return {
    id: r.id,
    serviceId: r.service_id,
    service: r.service_name,
    services,
    total: r.total,
    hasQuote: services.some((s) => s.price === null),
    name: r.client_name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    date: r.date,
    time: r.time,
    status: r.status,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Crea una cita validando todas las reglas de agenda. El índice único (date,time)
 * garantiza que dos peticiones simultáneas nunca reserven la misma hora.
 */
export async function createAppointment(
  db: D1Database,
  input: AppointmentInput,
  opts: { source: "web" | "admin"; now?: Date },
): Promise<AppointmentRow> {
  const now = opts.now ?? new Date();
  const isAdmin = opts.source === "admin";
  const services = input.serviceIds.map((id) => findService(id));
  if (services.length === 0 || services.some((s) => !s)) {
    throw new HttpError(400, "validation_error", "Servicio inválido", { serviceIds: "Elige al menos un servicio" });
  }
  const chosen = services as NonNullable<(typeof services)[number]>[];
  const summary: ApptService[] = chosen.map((s) => ({ id: s.id, name: s.name, price: s.price }));
  const total = summary.reduce((sum, s) => sum + (s.price ?? 0), 0);

  if (!isAdmin && !isWithinBookingWindow(input.date, now)) {
    const w = bookingWindow(now);
    throw new HttpError(400, "out_of_window", `Solo puedes reservar entre ${w.from} y ${w.to}`, {
      date: "Fecha fuera del rango de reservas",
    });
  }

  const [settings, data] = await Promise.all([loadSettings(db), loadRange(db, input.date, input.date)]);
  const day = resolveDay(
    input.date,
    settings,
    {
      dayOverride: data.dayOverrides.get(input.date),
      slotOverrides: data.slotOverrides.get(input.date) ?? [],
      booked: data.booked.get(input.date) ?? new Set(),
    },
    now,
  );
  const slot = day.slots.find((s) => s.time === input.time);
  const bookable = isAdmin ? slot && (slot.state === "available" || slot.state === "past") : slot?.state === "available" && day.open;
  if (!bookable) {
    const taken = slot?.state === "booked";
    throw new HttpError(409, taken ? "slot_taken" : "slot_unavailable", taken ? "Esa hora ya fue reservada" : "Esa hora no está disponible", {
      time: taken ? "Esa hora ya fue reservada, elige otra" : "Esa hora no está disponible",
    });
  }

  if (!isAdmin) {
    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM appointments WHERE phone = ?1 AND status = 'pendiente' AND date >= ?2")
      .bind(input.phone, bogotaNow(now).date)
      .first<{ n: number }>();
    if ((pending?.n ?? 0) >= MAX_PENDING_PER_PHONE) {
      throw new HttpError(429, "too_many_pending", "Ya tienes varias citas pendientes. Escríbele a Isabel por WhatsApp para más cambios.");
    }
  }

  const ts = new Date().toISOString();
  const row: AppointmentRow = {
    id: randomId(),
    service_id: chosen[0]!.id,
    service_name: chosen.map((s) => s.name).join(" + "),
    services_json: JSON.stringify(summary),
    total,
    client_name: input.name,
    phone: input.phone,
    email: input.email,
    notes: input.notes,
    date: input.date,
    time: input.time,
    status: "pendiente",
    source: opts.source,
    created_at: ts,
    updated_at: ts,
  };

  try {
    await db
      .prepare(
        `INSERT INTO appointments (id, service_id, service_name, services_json, total, client_name, phone, email, notes, date, time, status, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(row.id, row.service_id, row.service_name, row.services_json, row.total, row.client_name, row.phone, row.email, row.notes, row.date, row.time, row.status, row.source, row.created_at, row.updated_at)
      .run();
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes("UNIQUE")) {
      throw new HttpError(409, "slot_taken", "Esa hora ya fue reservada", { time: "Esa hora ya fue reservada, elige otra" });
    }
    throw err;
  }
  return row;
}
