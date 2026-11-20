import { env } from "cloudflare:workers";
import { vi } from "vitest";
import app from "../src/index";
import { hashPassword } from "../src/lib/crypto";

export const ORIGIN = "https://sitio.test";
export const PASSWORD = "clave-de-prueba-segura-123";
/** Viernes 2026-11-20 10:00 en Bogotá (15:00 UTC). */
export const NOW = new Date("2026-11-20T15:00:00Z");

let passwordHash: string | undefined;

export async function testEnv() {
  passwordHash ??= await hashPassword(PASSWORD, 1000);
  return { ...env, ADMIN_PASSWORD_HASH: passwordHash } as typeof env;
}

export async function resetDb() {
  await env.DB.batch(
    ["appointments", "day_overrides", "slot_overrides", "settings", "sessions", "rate_limits"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
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

export async function login(ip = "203.0.113.50"): Promise<string> {
  const res = await call("POST", "/api/admin/login", { body: { password: PASSWORD }, ip });
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
