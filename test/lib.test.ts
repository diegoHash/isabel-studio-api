import { describe, expect, it } from "vitest";
import { hashPassword, safeEqual, verifyPassword } from "../src/lib/crypto";
import { colombiaHolidays, easterSunday, holidayName } from "../src/lib/holidays";
import { DEFAULT_SLOTS, DEFAULT_WORK_DAYS, resolveDay, type Settings } from "../src/lib/schedule";
import { addDays, bogotaNow, isValidDate, weekday } from "../src/lib/time";
import { cleanText, createAppointmentSchema, normalizePhone } from "../src/lib/validation";

const settings: Settings = { slots: DEFAULT_SLOTS, workDays: DEFAULT_WORK_DAYS };

describe("zona horaria Bogotá", () => {
  it("convierte UTC a hora de Bogotá (UTC-5)", () => {
    expect(bogotaNow(new Date("2026-11-20T15:00:00Z"))).toEqual({ date: "2026-11-20", minutes: 600 });
    // 03:00 UTC sigue siendo el día anterior en Bogotá
    expect(bogotaNow(new Date("2026-11-21T03:00:00Z"))).toEqual({ date: "2026-11-20", minutes: 22 * 60 });
  });
  it("valida fechas reales", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("26-1-1")).toBe(false);
  });
  it("calcula día de la semana y suma de días", () => {
    expect(weekday("2026-11-22")).toBe(0); // domingo
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("festivos de Colombia", () => {
  it("Pascua 2026 es el 5 de abril", () => expect(easterSunday("2026" as unknown as number)).toBe("2026-04-05"));
  it("coincide con el calendario oficial 2026", () => {
    const expected = [
      "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-18",
      "2026-06-08", "2026-06-15", "2026-06-29", "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12",
      "2026-11-02", "2026-11-16", "2026-12-08", "2026-12-25",
    ];
    expect([...colombiaHolidays(2026).keys()].sort()).toEqual(expected);
  });
  it("coincide con el calendario oficial 2027", () => {
    const expected = [
      "2027-01-01", "2027-01-11", "2027-03-22", "2027-03-25", "2027-03-26", "2027-05-01", "2027-05-10",
      "2027-05-31", "2027-06-07", "2027-07-05", "2027-07-20", "2027-08-07", "2027-08-16", "2027-10-18",
      "2027-11-01", "2027-11-15", "2027-12-08", "2027-12-25",
    ];
    expect([...colombiaHolidays(2027).keys()].sort()).toEqual(expected);
  });
  it("devuelve el nombre del festivo o null", () => {
    expect(holidayName("2026-12-25")).toBe("Navidad");
    expect(holidayName("2026-11-24")).toBeNull();
  });
});

describe("agenda (resolveDay)", () => {
  const now = new Date("2026-11-20T15:00:00Z"); // viernes 10:00 Bogotá

  it("el domingo está cerrado", () => {
    const d = resolveDay("2026-11-22", settings, {}, now);
    expect(d).toMatchObject({ open: false, reason: "domingo", slots: [] });
  });
  it("los festivos están cerrados", () => {
    const d = resolveDay("2026-12-08", settings, {}, now);
    expect(d).toMatchObject({ open: false, reason: "festivo", holiday: "Inmaculada Concepción" });
  });
  it("lunes a sábado abren con las horas por defecto (sin 12:00)", () => {
    const d = resolveDay("2026-11-23", settings, {}, now);
    expect(d.open).toBe(true);
    expect(d.slots.map((s) => s.time)).toEqual(["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
    expect(d.slots.every((s) => s.state === "available")).toBe(true);
    expect(resolveDay("2026-11-28", settings, {}, now).open).toBe(true); // sábado
  });
  it("hoy exige 1 hora de antelación", () => {
    const d = resolveDay("2026-11-20", settings, {}, now);
    const state = (t: string) => d.slots.find((s) => s.time === t)?.state;
    expect(state("08:00")).toBe("past");
    expect(state("10:00")).toBe("past");
    expect(state("11:00")).toBe("available");
  });
  it("respeta horas reservadas, bloqueadas y extra", () => {
    const d = resolveDay(
      "2026-11-24",
      settings,
      {
        booked: new Set(["09:00"]),
        slotOverrides: [{ time: "10:00", is_open: 0 }, { time: "12:00", is_open: 1 }],
      },
      now,
    );
    const state = (t: string) => d.slots.find((s) => s.time === t);
    expect(state("09:00")?.state).toBe("booked");
    expect(state("10:00")?.state).toBe("blocked");
    expect(state("12:00")).toMatchObject({ state: "available", extra: true });
  });
  it("el admin puede deshabilitar un día o habilitar un domingo", () => {
    expect(resolveDay("2026-11-24", settings, { dayOverride: { is_open: 0, note: "Vacaciones" } }, now)).toMatchObject({
      open: false, reason: "deshabilitado", note: "Vacaciones",
    });
    const sunday = resolveDay("2026-11-29", settings, { dayOverride: { is_open: 1, note: null } }, now);
    expect(sunday.open).toBe(true);
    expect(sunday.slots).toHaveLength(9);
  });
});

describe("validación", () => {
  it("normaliza celulares colombianos", () => {
    expect(normalizePhone("+57 320 669 0456")).toBe("3206690456");
    expect(normalizePhone("(320) 669-0456")).toBe("3206690456");
    expect(normalizePhone("573206690456")).toBe("3206690456");
  });
  it("limpia texto peligroso", () => {
    expect(cleanText("  hola <script>alert(1)</script>\u0000  mundo ")).toBe("hola scriptalert(1)/script mundo");
  });
  const base = { serviceIds: ["trenzas"], date: "2026-11-24", time: "10:00", name: "Ana Pérez", phone: "3206690456" };
  it("acepta una reserva válida", () => {
    const r = createAppointmentSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ email: null, notes: null });
  });
  it.each([
    ["nombre con HTML", { name: "<img src=x onerror=alert(1)>" }],
    ["nombre con números", { name: "Ana 123" }],
    ["nombre de 1 letra", { name: "A" }],
    ["celular inválido", { phone: "1234567" }],
    ["fijo (no móvil)", { phone: "6012345678" }],
    ["correo inválido", { email: "no-es-correo" }],
    ["servicio inexistente", { serviceIds: ["x"] }],
    ["sin servicios", { serviceIds: [] }],
    ["demasiados servicios", { serviceIds: Array(9).fill("trenzas") }],
    ["fecha imposible", { date: "2026-02-30" }],
    ["hora inválida", { time: "25:00" }],
    ["notas muy largas", { notes: "a".repeat(301) }],
    ["campo desconocido", { admin: true }],
  ])("rechaza %s", (_label, over) => {
    expect(createAppointmentSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });
});

describe("crypto", () => {
  it("verifica contraseñas con PBKDF2", async () => {
    const hash = await hashPassword("una-clave-larga", 1000);
    expect(hash.startsWith("pbkdf2$1000$")).toBe(true);
    expect(await verifyPassword("una-clave-larga", hash)).toBe(true);
    expect(await verifyPassword("otra", hash)).toBe(false);
  });
  it("falla de forma segura sin hash o con hash corrupto", async () => {
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(await verifyPassword("x", "basura")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$1000$zz$zz")).toBe(false);
  });
  it("safeEqual compara en tiempo constante", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
  });
});
