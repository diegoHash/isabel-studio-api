import { holidayName } from "./holidays";
import { addDays, bogotaNow, diffDays, eachDate, timeToMinutes, weekday } from "./time";

export const DEFAULT_SLOTS = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
/** Lunes (1) a sábado (6). Domingo (0) no se trabaja. */
export const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5, 6];

/** Antelación mínima para reservar (minutos) y ventana máxima (días). */
export const MIN_LEAD_MINUTES = 60;
export const MAX_DAYS_AHEAD = 60;

export interface Settings {
  slots: string[];
  workDays: number[];
}

export type SlotState = "available" | "booked" | "blocked" | "past";
export type ClosedReason = "domingo" | "festivo" | "no-laboral" | "deshabilitado" | "pasado";

export interface DaySlot {
  time: string;
  state: SlotState;
  /** true si es una hora extra habilitada manualmente (fuera del horario base). */
  extra?: boolean;
}

export interface DayInfo {
  date: string;
  open: boolean;
  reason: ClosedReason | null;
  holiday: string | null;
  note: string | null;
  /** Cuando el día está cerrado el admin aún puede ver qué día es por defecto. */
  defaultOpen: boolean;
  slots: DaySlot[];
}

export interface DayInputs {
  dayOverride?: { is_open: number; note: string | null } | undefined;
  slotOverrides?: { time: string; is_open: number }[];
  booked?: Set<string>;
}

export function defaultOpen(date: string, settings: Settings): { open: boolean; reason: ClosedReason | null; holiday: string | null } {
  const holiday = holidayName(date);
  const wd = weekday(date);
  if (holiday) return { open: false, reason: "festivo", holiday };
  if (!settings.workDays.includes(wd)) {
    return { open: false, reason: wd === 0 ? "domingo" : "no-laboral", holiday: null };
  }
  return { open: true, reason: null, holiday: null };
}

export function resolveDay(
  date: string,
  settings: Settings,
  inputs: DayInputs = {},
  now: Date = new Date(),
): DayInfo {
  const base = defaultOpen(date, settings);
  const ov = inputs.dayOverride;
  const today = bogotaNow(now);

  let open = base.open;
  let reason = base.reason;
  if (ov) {
    open = ov.is_open === 1;
    reason = open ? null : base.open ? "deshabilitado" : base.reason ?? "deshabilitado";
  }
  const isPastDay = date < today.date;
  if (isPastDay && open) {
    // Los días pasados se muestran sin horas reservables.
    reason = "pasado";
  }

  const slotOv = new Map((inputs.slotOverrides ?? []).map((s) => [s.time, s.is_open]));
  const times = new Set(settings.slots);
  const extras = new Set<string>();
  for (const [time, isOpen] of slotOv) {
    if (isOpen === 1 && !times.has(time)) {
      times.add(time);
      extras.add(time);
    }
  }

  const slots: DaySlot[] = open
    ? [...times].sort().map((time) => {
        let state: SlotState = "available";
        if (inputs.booked?.has(time)) state = "booked";
        else if (slotOv.get(time) === 0) state = "blocked";
        else if (isPastSlot(date, time, now)) state = "past";
        const slot: DaySlot = { time, state };
        if (extras.has(time)) slot.extra = true;
        return slot;
      })
    : [];

  return {
    date,
    open: open && !isPastDay,
    reason,
    holiday: base.holiday,
    note: ov?.note ?? null,
    defaultOpen: base.open,
    slots,
  };
}

export function isPastSlot(date: string, time: string, now: Date = new Date()): boolean {
  const today = bogotaNow(now);
  if (date < today.date) return true;
  if (date > today.date) return false;
  return timeToMinutes(time) < today.minutes + MIN_LEAD_MINUTES;
}

export function bookingWindow(now: Date = new Date()): { from: string; to: string } {
  const today = bogotaNow(now).date;
  return { from: today, to: addDays(today, MAX_DAYS_AHEAD) };
}

export function isWithinBookingWindow(date: string, now: Date = new Date()): boolean {
  const w = bookingWindow(now);
  return date >= w.from && date <= w.to;
}

export { eachDate, diffDays };

// ---------- Acceso a D1 ----------

export async function loadSettings(db: D1Database): Promise<Settings> {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('slots', 'workDays')").all<{ key: string; value: string }>();
  const settings: Settings = { slots: [...DEFAULT_SLOTS], workDays: [...DEFAULT_WORK_DAYS] };
  for (const r of rows.results) {
    try {
      const parsed = JSON.parse(r.value);
      if (r.key === "slots" && Array.isArray(parsed)) settings.slots = parsed;
      if (r.key === "workDays" && Array.isArray(parsed)) settings.workDays = parsed;
    } catch {
      /* se conservan los valores por defecto */
    }
  }
  return settings;
}

export async function saveSettings(db: D1Database, settings: Settings): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO settings (key, value) VALUES ('slots', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(settings.slots)),
    db.prepare("INSERT INTO settings (key, value) VALUES ('workDays', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(JSON.stringify(settings.workDays)),
  ]);
}

export interface RangeData {
  dayOverrides: Map<string, { is_open: number; note: string | null }>;
  slotOverrides: Map<string, { time: string; is_open: number }[]>;
  booked: Map<string, Set<string>>;
}

export async function loadRange(db: D1Database, from: string, to: string): Promise<RangeData> {
  const [days, slots, booked] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT date, is_open, note FROM day_overrides WHERE date BETWEEN ?1 AND ?2").bind(from, to),
    db.prepare("SELECT date, time, is_open FROM slot_overrides WHERE date BETWEEN ?1 AND ?2").bind(from, to),
    db.prepare("SELECT date, time FROM appointments WHERE date BETWEEN ?1 AND ?2").bind(from, to),
  ]);
  const data: RangeData = { dayOverrides: new Map(), slotOverrides: new Map(), booked: new Map() };
  for (const r of days!.results as { date: string; is_open: number; note: string | null }[]) {
    data.dayOverrides.set(r.date, { is_open: r.is_open, note: r.note });
  }
  for (const r of slots!.results as { date: string; time: string; is_open: number }[]) {
    const list = data.slotOverrides.get(r.date) ?? [];
    list.push({ time: r.time, is_open: r.is_open });
    data.slotOverrides.set(r.date, list);
  }
  for (const r of booked!.results as { date: string; time: string }[]) {
    const set = data.booked.get(r.date) ?? new Set<string>();
    set.add(r.time);
    data.booked.set(r.date, set);
  }
  return data;
}

export function resolveRange(
  from: string,
  to: string,
  settings: Settings,
  data: RangeData,
  now: Date = new Date(),
): DayInfo[] {
  return eachDate(from, to).map((date) =>
    resolveDay(
      date,
      settings,
      {
        dayOverride: data.dayOverrides.get(date),
        slotOverrides: data.slotOverrides.get(date) ?? [],
        booked: data.booked.get(date) ?? new Set(),
      },
      now,
    ),
  );
}
