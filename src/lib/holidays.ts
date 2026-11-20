import { addDays, formatDate, weekday } from "./time";

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatDate(new Date(Date.UTC(year, month - 1, day)));
}

/** Ley Emiliani: traslada el festivo al lunes siguiente (si ya es lunes, se queda). */
function toNextMonday(date: string): string {
  const wd = weekday(date);
  if (wd === 1) return date;
  return addDays(date, (8 - wd) % 7);
}

const pad = (n: number) => String(n).padStart(2, "0");

const cache = new Map<number, Map<string, string>>();

/** Festivos de Colombia para un año: fecha -> nombre. */
export function colombiaHolidays(year: number): Map<string, string> {
  const cached = cache.get(year);
  if (cached) return cached;

  const h = new Map<string, string>();
  const fixed = (m: number, d: number, name: string) => h.set(`${year}-${pad(m)}-${pad(d)}`, name);
  const moved = (m: number, d: number, name: string) =>
    h.set(toNextMonday(`${year}-${pad(m)}-${pad(d)}`), name);

  // Fijos
  fixed(1, 1, "Año Nuevo");
  fixed(5, 1, "Día del Trabajo");
  fixed(7, 20, "Día de la Independencia");
  fixed(8, 7, "Batalla de Boyacá");
  fixed(12, 8, "Inmaculada Concepción");
  fixed(12, 25, "Navidad");

  // Trasladados al lunes
  moved(1, 6, "Reyes Magos");
  moved(3, 19, "San José");
  moved(6, 29, "San Pedro y San Pablo");
  moved(8, 15, "Asunción de la Virgen");
  moved(10, 12, "Día de la Raza");
  moved(11, 1, "Todos los Santos");
  moved(11, 11, "Independencia de Cartagena");

  // Móviles según la Pascua
  const easter = easterSunday(year);
  h.set(addDays(easter, -3), "Jueves Santo");
  h.set(addDays(easter, -2), "Viernes Santo");
  h.set(addDays(easter, 43), "Ascensión del Señor");
  h.set(addDays(easter, 64), "Corpus Christi");
  h.set(addDays(easter, 71), "Sagrado Corazón");

  cache.set(year, h);
  return h;
}

export function holidayName(date: string): string | null {
  const year = Number(date.slice(0, 4));
  return colombiaHolidays(year).get(date) ?? null;
}
