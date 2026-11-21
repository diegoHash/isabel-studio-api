import { env } from "cloudflare:workers";
import { vi } from "vitest";
import app from "../src/index";

export const ORIGIN = "https://sitio.test";
export const ROOT_EMAIL = "root@sitio.test";
export const FAKE_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQxMjM0NTY3OA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
/** Viernes 2026-11-20 10:00 en Bogotá (15:00 UTC). */
export const NOW = new Date("2026-11-20T15:00:00Z");

export async function testEnv() {
  return env;
}

export async function seedUser(email: string, opts: { role?: "root" | "staff"; permissions?: string[]; active?: boolean; name?: string } = {}) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, role, permissions, password_hash, active, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)",
  )
    .bind(id, email, opts.name ?? email.split("@")[0], opts.role ?? "staff", JSON.stringify(opts.permissions ?? []), FAKE_HASH, opts.active === false ? 0 : 1, ts)
    .run();
  return id;
}

export async function resetDb() {
  await env.DB.batch(
    ["appointments", "day_overrides", "slot_overrides", "settings", "sessions", "rate_limits", "users"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await seedUser(ROOT_EMAIL, { role: "root", name: "Diego" });
}

export function freezeTime(date: Date = NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(date);
}

interface CallOpts {
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  origin?: string | null;
  secret?: string | null;
  ip?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
}

export async function call(method: string, path: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = {};
  if (opts.secret !== null) headers["x-proxy-secret"] = opts.secret ?? env.PROXY_SECRET!;
  headers["x-client-ip"] = opts.ip ?? "203.0.113.7";
  if (opts.origin !== null && method !== "GET") headers["origin"] = opts.origin ?? ORIGIN;
  if (opts.cookie) headers["cookie"] = opts.cookie;
  Object.assign(headers, opts.headers);
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  if (hasBody && opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  const res = await app.request(
    path,
    { method, headers, body: hasBody ? (opts.rawBody ?? JSON.stringify(opts.body)) : undefined },
    await testEnv(),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* sin cuerpo JSON */
  }
  return { status: res.status, headers: res.headers, json };
}

/** Simula el login: el proxy de Vercel ya verificó Argon2 y manda el veredicto. */
export async function login(email = ROOT_EMAIL, ip = "203.0.113.50"): Promise<string> {
  const res = await call("POST", "/api/admin/login", { body: { email }, headers: { "x-admin-verified": "1" }, ip });
  if (res.status !== 200) throw new Error("login falló en test: " + JSON.stringify(res.json));
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]!;
}

export const validBooking = (over: Record<string, unknown> = {}) => ({
  serviceIds: ["manicure-semipermanente"],
  date: "2026-11-24", // martes
  time: "10:00",
  name: "María Fernanda López",
  phone: "320 669 0456",
  email: "maria@example.com",
  notes: "Diseño francés",
  ...over,
});

export async function setPublished(value: boolean) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('published', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(value ? "1" : "0").run();
}
