import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { HttpError } from "../lib/http";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export function cookieName(env: AppEnv["Bindings"]): string {
  // El prefijo __Host- exige Secure + Path=/ + sin Domain (solo producción, que es HTTPS).
  return env.ENVIRONMENT === "production" ? "__Host-isabel_session" : "isabel_session";
}

export async function createSession(c: Context<AppEnv>): Promise<void> {
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    // Limpieza de ventanas de rate limit antiguas (más de 1 día).
    c.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - 86_400_000),
    c.env.DB.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)").bind(
      await sha256Hex(token),
      now,
      now + SESSION_TTL_SECONDS * 1000,
    ),
  ]);
  setCookie(c, cookieName(c.env), token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === "production",
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, cookieName(c.env));
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, cookieName(c.env), { path: "/", secure: c.env.ENVIRONMENT === "production" });
}

export async function hasValidSession(c: Context<AppEnv>): Promise<boolean> {
  const token = getCookie(c, cookieName(c.env));
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const row = await c.env.DB.prepare("SELECT 1 AS ok FROM sessions WHERE token_hash = ?1 AND expires_at > ?2")
    .bind(await sha256Hex(token), Date.now())
    .first();
  return !!row;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await hasValidSession(c))) throw new HttpError(401, "unauthorized", "Inicia sesión para continuar");
  return next();
};
