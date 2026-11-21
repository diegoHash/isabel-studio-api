import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { PERMISSIONS, type AppEnv, type AuthUser, type Permission } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { HttpError } from "../lib/http";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export function cookieName(env: AppEnv["Bindings"]): string {
  // El prefijo __Host- exige Secure + Path=/ + sin Domain (solo producción, que es HTTPS).
  return env.ENVIRONMENT === "production" ? "__Host-isabel_session" : "isabel_session";
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    // Limpieza de ventanas de rate limit antiguas (más de 1 día).
    c.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - 86_400_000),
    c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(
      await sha256Hex(token),
      userId,
      now,
      now + SESSION_TTL_SECONDS * 1000,
    ),
    c.env.DB.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(new Date().toISOString(), userId),
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

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "root" | "staff";
  permissions: string;
}

export function parsePermissions(raw: string, role: string): Permission[] {
  if (role === "root") return [...PERMISSIONS];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? PERMISSIONS.filter((p) => arr.includes(p)) : [];
  } catch {
    return [];
  }
}

/** Usuario dueño de la sesión actual (solo si la sesión vive y el usuario está activo). */
export async function currentUser(c: Context<AppEnv>): Promise<AuthUser | null> {
  const token = getCookie(c, cookieName(c.env));
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.permissions
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.active = 1
        AND (u.role = 'root' OR (SELECT value FROM settings WHERE key = 'published') = '1')`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<UserRow>();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, permissions: parsePermissions(row.permissions, row.role) };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) throw new HttpError(401, "unauthorized", "Inicia sesión para continuar");
  c.set("user", user);
  return next();
};

/** Exige al menos uno de los permisos indicados (el root siempre pasa). */
export const requirePermission =
  (...perms: Permission[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const user = c.get("user");
    if (user.role !== "root" && !perms.some((p) => user.permissions.includes(p))) {
      throw new HttpError(403, "forbidden", "No tienes permiso para esta acción");
    }
    return next();
  };

/** Solo el administrador principal. */
export const requireRoot: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "root") throw new HttpError(403, "forbidden", "Solo el administrador principal puede hacer esto");
  return next();
};

export async function isPublished(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'published'").first<{ value: string }>();
  return row?.value === "1";
}

export const can = (user: AuthUser, perm: Permission) => user.role === "root" || user.permissions.includes(perm);
