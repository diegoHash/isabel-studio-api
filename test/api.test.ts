import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, ORIGIN, call, freezeTime, login, resetDb, validBooking } from "./helpers";

beforeEach(async () => {
  await resetDb();
  freezeTime();
});
afterEach(() => vi.useRealTimers());

describe("seguridad de la capa HTTP", () => {
  it("bloquea llamadas que no vienen del proxy de Vercel", async () => {
    expect((await call("GET", "/api/services", { secret: null })).status).toBe(403);
    expect((await call("GET", "/api/services", { secret: "incorrecto" })).status).toBe(403);
    expect((await call("GET", "/api/services")).status).toBe(200);
  });

  it("anti-CSRF: rechaza POST sin origen o con origen no autorizado", async () => {
    const body = validBooking();
    expect((await call("POST", "/api/appointments", { body, origin: null })).status).toBe(403);
    expect((await call("POST", "/api/appointments", { body, origin: "https://malicioso.example" })).status).toBe(403);
    expect((await call("POST", "/api/appointments", { body, origin: ORIGIN })).status).toBe(201);
  });

  it("exige Content-Type JSON y limita el tamaño del cuerpo", async () => {
    expect((await call("POST", "/api/appointments", { rawBody: "x=1", contentType: "text/plain" })).status).toBe(415);
    expect((await call("POST", "/api/appointments", { rawBody: "{no json", contentType: "application/json" })).status).toBe(400);
    const big = JSON.stringify(validBooking({ notes: "a".repeat(20_000) }));
    expect((await call("POST", "/api/appointments", { rawBody: big })).status).toBe(413);
  });

  it("envía cabeceras de seguridad y nunca cachea", async () => {
    const { headers } = await call("GET", "/api/services");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("strict-transport-security")).toContain("max-age=");
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("los errores no filtran detalles internos", async () => {
    const res = await call("GET", "/api/no-existe");
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.json)).not.toMatch(/stack|at .*\.ts/);
  });
});

describe("catálogo y disponibilidad", () => {
  it("lista los servicios con precios en COP", async () => {
    const { json } = await call("GET", "/api/services");
    const byId = Object.fromEntries(json.services.map((s: any) => [s.id, s]));
    expect(byId["sistema-acrilico"].price).toBe(100000);
    expect(byId["micropigmentacion-cejas"].price).toBe(160000);
    expect(byId["depilacion-cejas"].price).toBe(10000);
    expect(byId["keratina"].price).toBeNull();
    expect(json.services).toHaveLength(14);
  });

  it("domingos y festivos aparecen cerrados; lunes a sábado abiertos", async () => {
    const { json } = await call("GET", "/api/availability?from=2026-11-20&to=2026-12-09");
    const day = (d: string) => json.days.find((x: any) => x.date === d);
    expect(day("2026-11-22")).toMatchObject({ open: false, reason: "domingo", slots: [] });
    expect(day("2026-12-08")).toMatchObject({ open: false, reason: "festivo" });
    expect(day("2026-11-23").open).toBe(true);
    expect(day("2026-11-28").open).toBe(true);
    expect(day("2026-11-24").slots).toEqual(["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
    expect(json.timezone).toBe("America/Bogota");
  });

  it("hoy solo ofrece horas con al menos 1 hora de antelación", async () => {
    const { json } = await call("GET", "/api/availability?from=2026-11-20&to=2026-11-20");
    expect(json.days[0].slots).toEqual(["11:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
  });

  it("recorta el rango a la ventana de reservas y valida parámetros", async () => {
    const { json } = await call("GET", "/api/availability?from=2020-01-01&to=2030-01-01");
    expect(json.days.length).toBeLessThanOrEqual(62);
    expect(json.days[0].date).toBe("2026-11-20");
    expect((await call("GET", "/api/availability?from=hoy&to=mañana")).status).toBe(400);
    expect((await call("GET", "/api/availability")).status).toBe(400);
  });
});

describe("reservas", () => {
  it("crea una cita pendiente, normaliza datos y bloquea la hora", async () => {
    const res = await call("POST", "/api/appointments", { body: validBooking() });
    expect(res.status).toBe(201);
    expect(res.json.appointment).toMatchObject({
      service: "Manicure semipermanente", date: "2026-11-24", time: "10:00", status: "pendiente", phone: "3206690456",
    });
    const av = await call("GET", "/api/availability?from=2026-11-24&to=2026-11-24");
    expect(av.json.days[0].slots).not.toContain("10:00");
  });

  it("el carrito: varios servicios en una cita, con total y sin duplicados", async () => {
    const res = await call("POST", "/api/appointments", {
      body: validBooking({ serviceIds: ["manicure-semipermanente", "pedicure-semipermanente", "manicure-semipermanente", "keratina"] }),
    });
    expect(res.status).toBe(201);
    const a = res.json.appointment;
    expect(a.services.map((s: any) => s.id)).toEqual(["manicure-semipermanente", "pedicure-semipermanente", "keratina"]);
    expect(a.total).toBe(88000); // 48.000 + 40.000 (keratina se cotiza)
    expect(a.hasQuote).toBe(true);
    expect(a.service).toBe("Manicure semipermanente + Pedicure semipermanente + Aplicación de keratina");
    const cookie = await login();
    const list = await call("GET", "/api/admin/appointments?q=pedicure", { cookie });
    expect(list.json.appointments[0].total).toBe(88000);
  });

  it("evita la doble reserva de la misma hora", async () => {
    expect((await call("POST", "/api/appointments", { body: validBooking() })).status).toBe(201);
    const dup = await call("POST", "/api/appointments", { body: validBooking({ name: "Otra Persona", phone: "3101234567" }), ip: "198.51.100.1" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("slot_taken");
  });

  it("dos peticiones simultáneas: solo una gana", async () => {
    const results = await Promise.all([
      call("POST", "/api/appointments", { body: validBooking({ time: "14:00" }), ip: "198.51.100.10" }),
      call("POST", "/api/appointments", { body: validBooking({ time: "14:00", phone: "3101234567", name: "Luisa Gómez" }), ip: "198.51.100.11" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it.each([
    ["domingo", { date: "2026-11-29" }],
    ["festivo", { date: "2026-12-08" }],
    ["hora que no existe en la agenda (12:00)", { time: "12:00" }],
    ["hora pasada de hoy", { date: "2026-11-20", time: "08:00" }],
  ])("rechaza reservar en %s", async (_l, over) => {
    const res = await call("POST", "/api/appointments", { body: validBooking(over) });
    expect(res.status).toBe(409);
  });

  it("rechaza fechas fuera de la ventana de 60 días o en el pasado", async () => {
    expect((await call("POST", "/api/appointments", { body: validBooking({ date: "2027-03-01" }) })).status).toBe(400);
    expect((await call("POST", "/api/appointments", { body: validBooking({ date: "2026-11-10" }) })).status).toBe(400);
  });

  it("valida los campos y devuelve errores por campo", async () => {
    const res = await call("POST", "/api/appointments", {
      body: validBooking({ name: "<script>alert(1)</script>", phone: "123", email: "x" }),
    });
    expect(res.status).toBe(400);
    expect(Object.keys(res.json.error.fields)).toEqual(expect.arrayContaining(["name", "phone", "email"]));
  });

  it("sanea las notas (sin HTML ni caracteres de control)", async () => {
    const res = await call("POST", "/api/appointments", { body: validBooking({ notes: "Hola <b>Isabel</b>\u0000\n\nbonito" }) });
    expect(res.status).toBe(201);
    expect(res.json.appointment.notes).toBe("Hola bIsabel/b bonito");
  });

  it("usa consultas parametrizadas (inyección SQL no tiene efecto)", async () => {
    const res = await call("POST", "/api/appointments", { body: validBooking({ notes: "'); DROP TABLE appointments;--" }) });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM appointments").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("honeypot: un bot recibe 201 pero no se guarda nada", async () => {
    const res = await call("POST", "/api/appointments", { body: { ...validBooking(), website: "http://spam.example" } });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM appointments").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("rate limit por IP: la 7ª reserva en una hora recibe 429 con Retry-After", async () => {
    const times = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00"];
    for (const [i, time] of times.entries()) {
      const r = await call("POST", "/api/appointments", {
        body: validBooking({ time, phone: `31000000${String(i).padStart(2, "0")}`, name: `Persona ${"abcdef"[i]}` }),
        ip: "198.51.100.77",
      });
      expect(r.status).toBe(201);
    }
    const blocked = await call("POST", "/api/appointments", { body: validBooking({ time: "15:00", phone: "3109999999" }), ip: "198.51.100.77" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // otra IP no se ve afectada
    const other = await call("POST", "/api/appointments", { body: validBooking({ time: "15:00", phone: "3109999999" }), ip: "198.51.100.78" });
    expect(other.status).toBe(201);
  });

  it("limita a 3 citas pendientes por celular", async () => {
    for (const time of ["08:00", "09:00", "10:00"]) {
      expect((await call("POST", "/api/appointments", { body: validBooking({ time }) })).status).toBe(201);
    }
    const res = await call("POST", "/api/appointments", { body: validBooking({ time: "11:00" }) });
    expect(res.status).toBe(429);
    expect(res.json.error.code).toBe("too_many_pending");
  });
});

describe("panel de administración: autenticación", () => {
  it("las rutas del panel exigen sesión", async () => {
    for (const [m, p] of [["GET", "/api/admin/appointments"], ["GET", "/api/admin/summary"], ["GET", "/api/admin/settings"], ["PUT", "/api/admin/days/2026-11-24"]] as const) {
      expect((await call(m, p, m === "GET" ? {} : { body: { open: false } })).status).toBe(401);
    }
    expect((await call("GET", "/api/admin/me")).json).toEqual({ authenticated: false });
  });

  it("rechaza clave incorrecta y la API no revela si hay usuario", async () => {
    const res = await call("POST", "/api/admin/login", { body: { password: "mala" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("bloquea fuerza bruta: 5 intentos por IP cada 15 minutos", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call("POST", "/api/admin/login", { body: { password: "mala" + i }, ip: "192.0.2.9" })).status).toBe(401);
    }
    const blocked = await call("POST", "/api/admin/login", { body: { password: "otra" }, ip: "192.0.2.9" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("la cookie de sesión es HttpOnly, SameSite=Strict y la sesión se puede cerrar", async () => {
    const res = await call("POST", "/api/admin/login", { body: { password: (await import("./helpers")).PASSWORD } });
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Max-Age=28800/);
    const cookie = sc.split(";")[0]!;
    expect((await call("GET", "/api/admin/me", { cookie })).json).toEqual({ authenticated: true });
    // el token no se guarda en claro
    const stored = await env.DB.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(cookie).not.toContain(stored.results[0]!.token_hash);
    await call("POST", "/api/admin/logout", { cookie });
    expect((await call("GET", "/api/admin/summary", { cookie })).status).toBe(401);
  });

  it("login exige origen autorizado (CSRF)", async () => {
    const res = await call("POST", "/api/admin/login", { body: { password: "x" }, origin: "https://malicioso.example" });
    expect(res.status).toBe(403);
  });

  it("una cookie inventada no da acceso", async () => {
    const res = await call("GET", "/api/admin/appointments", { cookie: "isabel_session=" + "a".repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe("panel de administración: citas", () => {
  it("lista, filtra, cambia estado y elimina citas", async () => {
    const cookie = await login();
    await call("POST", "/api/appointments", { body: validBooking({ time: "09:00", name: "Ana Torres", phone: "3001112233" }), ip: "198.51.100.1" });
    await call("POST", "/api/appointments", { body: validBooking({ date: "2026-11-25", time: "10:00", serviceIds: ["sistema-acrilico"] }), ip: "198.51.100.2" });

    const all = await call("GET", "/api/admin/appointments", { cookie });
    expect(all.json.appointments.map((a: any) => `${a.date} ${a.time}`)).toEqual(["2026-11-24 09:00", "2026-11-25 10:00"]);

    const byName = await call("GET", "/api/admin/appointments?q=torres", { cookie });
    expect(byName.json.appointments).toHaveLength(1);
    const wild = await call("GET", "/api/admin/appointments?q=%25", { cookie });
    expect(wild.json.appointments).toHaveLength(0); // % se escapa, no es comodín
    const byDay = await call("GET", "/api/admin/appointments?from=2026-11-25&to=2026-11-25", { cookie });
    expect(byDay.json.appointments).toHaveLength(1);

    const id = all.json.appointments[0].id;
    const patched = await call("PATCH", `/api/admin/appointments/${id}`, { cookie, body: { status: "atendida" } });
    expect(patched.json.appointment.status).toBe("atendida");
    expect((await call("GET", "/api/admin/appointments?status=pendiente", { cookie })).json.appointments).toHaveLength(1);
    expect((await call("PATCH", `/api/admin/appointments/${id}`, { cookie, body: { status: "cancelada" } })).status).toBe(400);
    expect((await call("PATCH", "/api/admin/appointments/no-es-uuid", { cookie, body: { status: "atendida" } })).status).toBe(404);

    expect((await call("DELETE", `/api/admin/appointments/${id}`, { cookie })).status).toBe(200);
    expect((await call("DELETE", `/api/admin/appointments/${id}`, { cookie })).status).toBe(404);
    // la hora vuelve a estar disponible
    const av = await call("GET", "/api/availability?from=2026-11-24&to=2026-11-24");
    expect(av.json.days[0].slots).toContain("09:00");
  });

  it("el resumen cuenta citas de hoy, pendientes y próximas", async () => {
    const cookie = await login();
    await call("POST", "/api/appointments", { body: validBooking({ date: "2026-11-20", time: "15:00" }) });
    await call("POST", "/api/appointments", { body: validBooking({ time: "09:00" }) });
    const { json } = await call("GET", "/api/admin/summary", { cookie });
    expect(json).toMatchObject({ today: "2026-11-20", todayTotal: 1, pendingUpcoming: 2, nextSevenDays: 1, attendedTotal: 0 });
  });

  it("la dueña puede agendar manualmente (WhatsApp / presencial)", async () => {
    const cookie = await login();
    const res = await call("POST", "/api/admin/appointments", { cookie, body: validBooking({ time: "16:00" }) });
    expect(res.status).toBe(201);
    expect(res.json.appointment.source).toBe("admin");
    expect((await call("POST", "/api/admin/appointments", { cookie, body: validBooking({ time: "16:00" }) })).status).toBe(409);
  });
});

describe("panel de administración: horarios y días", () => {
  it("deshabilitar y habilitar un día", async () => {
    const cookie = await login();
    const off = await call("PUT", "/api/admin/days/2026-11-24", { cookie, body: { open: false, note: "Capacitación" } });
    expect(off.status).toBe(200);
    let av = await call("GET", "/api/availability?from=2026-11-24&to=2026-11-24");
    expect(av.json.days[0]).toMatchObject({ open: false, reason: "deshabilitado", slots: [] });
    expect((await call("POST", "/api/appointments", { body: validBooking() })).status).toBe(409);

    await call("DELETE", "/api/admin/days/2026-11-24", { cookie });
    av = await call("GET", "/api/availability?from=2026-11-24&to=2026-11-24");
    expect(av.json.days[0].open).toBe(true);

    // habilitar un domingo
    await call("PUT", "/api/admin/days/2026-11-29", { cookie, body: { open: true } });
    av = await call("GET", "/api/availability?from=2026-11-29&to=2026-11-29");
    expect(av.json.days[0].open).toBe(true);
    expect(av.json.days[0].slots.length).toBe(9);
  });

  it("avisa cuántas citas pendientes tiene un día que se deshabilita", async () => {
    const cookie = await login();
    await call("POST", "/api/appointments", { body: validBooking() });
    const off = await call("PUT", "/api/admin/days/2026-11-24", { cookie, body: { open: false } });
    expect(off.json.pendingAppointmentsOnDay).toBe(1);
  });

  it("deshabilitar y habilitar una hora", async () => {
    const cookie = await login();
    await call("PUT", "/api/admin/slots/2026-11-24/10:00", { cookie, body: { open: false } });
    let av = await call("GET", "/api/availability?from=2026-11-24&to=2026-11-24");
    expect(av.json.days[0].slots).not.toContain("10:00");
    expect((await call("POST", "/api/appointments", { body: validBooking() })).status).toBe(409);

    await call("DELETE", "/api/admin/slots/2026-11-24/10:00", { cookie });
    await call("PUT", "/api/admin/slots/2026-11-24/12:00", { cookie, body: { open: true } }); // hora extra
    av = await call("GET", "/api/availability?from=2026-11-24&to=2026-11-24");
    expect(av.json.days[0].slots).toContain("10:00");
    expect(av.json.days[0].slots).toContain("12:00");
    expect((await call("PUT", "/api/admin/slots/2026-11-24/99:99", { cookie, body: { open: true } })).status).toBe(400);
  });

  it("la agenda muestra el estado de cada hora y la cita asociada", async () => {
    const cookie = await login();
    await call("POST", "/api/appointments", { body: validBooking({ time: "09:00" }) });
    await call("PUT", "/api/admin/slots/2026-11-24/10:00", { cookie, body: { open: false } });
    const { json } = await call("GET", "/api/admin/schedule?from=2026-11-24&to=2026-11-24", { cookie });
    const slots = json.days[0].slots;
    expect(slots.find((s: any) => s.time === "09:00")).toMatchObject({ state: "booked", appointment: { name: "María Fernanda López" } });
    expect(slots.find((s: any) => s.time === "10:00").state).toBe("blocked");
    expect(slots.find((s: any) => s.time === "11:00").state).toBe("available");
  });

  it("configura las horas base y los días laborales", async () => {
    const cookie = await login();
    const put = await call("PUT", "/api/admin/settings", { cookie, body: { slots: ["09:00", "08:00", "08:00", "15:30"], workDays: [2, 4, 4, 6] } });
    expect(put.json.settings).toEqual({ slots: ["08:00", "09:00", "15:30"], workDays: [2, 4, 6] });
    const av = await call("GET", "/api/availability?from=2026-11-23&to=2026-11-25");
    expect(av.json.days.map((d: any) => d.open)).toEqual([false, true, false]); // lun, mar, mié
    expect(av.json.days[1].slots).toEqual(["08:00", "09:00", "15:30"]);
    expect((await call("PUT", "/api/admin/settings", { cookie, body: { slots: [], workDays: [1] } })).status).toBe(400);
    expect((await call("PUT", "/api/admin/settings", { cookie, body: { slots: ["8am"], workDays: [9] } })).status).toBe(400);
  });
});

it("usa el reloj congelado de Bogotá", () => {
  expect(new Date().toISOString()).toBe(NOW.toISOString());
});
