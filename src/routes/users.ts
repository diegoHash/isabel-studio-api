import { Hono } from "hono";
import type { AppEnv, AuthUser, Permission } from "../env";
import { PERMISSIONS } from "../env";
import { getCookie } from "hono/cookie";
import { randomId, sha256Hex } from "../lib/crypto";
import { rateLimit } from "../lib/ratelimit";
import { HttpError, readJson } from "../lib/http";
import { createUserSchema, selfPasswordSchema, updateUserSchema } from "../lib/validation";
import { cookieName, parsePermissions, requireAdmin, requirePermission } from "../middleware/auth";

export const userRoutes = new Hono<AppEnv>();

// Defensa en profundidad: exige sesión aunque otro middleware ya lo haya hecho.
userRoutes.use("*", async (c, next) => (c.get("user") ? next() : requireAdmin(c, next)));

const ID_RE = /^[0-9a-f-]{36}$/;

interface Row {
  id: string;
  email: string;
  name: string;
  role: "root" | "staff";
  permissions: string;
  active: number;
  created_at: string;
  last_login_at: string | null;
}
const toApi = (r: Row) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  permissions: parsePermissions(r.permissions, r.role),
  active: r.active === 1,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});
const COLS = "id, email, name, role, permissions, active, created_at, last_login_at";

/** Un usuario con permiso de usuarios que no es root no puede dar el permiso "users" (evita escalar privilegios). */
function assertGrantable(actor: AuthUser, perms: Permission[]) {
  if (actor.role !== "root" && perms.includes("users")) {
    throw new HttpError(403, "forbidden", "Solo el administrador principal puede dar el permiso de administrar usuarios");
  }
  const missing = perms.filter((p) => actor.role !== "root" && !actor.permissions.includes(p));
  if (missing.length) throw new HttpError(403, "forbidden", "No puedes dar permisos que tú no tienes");
}

// Cuenta intentos de verificar la clave actual (la verificación ocurre en Vercel). Limita fuerza bruta con una sesión robada.
userRoutes.post("/me/password-attempt", async (c) => {
  const me = c.get("user");
  const rl = await rateLimit(c.env.DB, "pw-attempt", me.id, 5, 900);
  if (!rl.ok) throw new HttpError(429, "rate_limited", "Demasiados intentos. Espera unos minutos.", undefined, { "Retry-After": String(rl.retryAfter) });
  return c.json({ email: me.email });
});

// Cambiar la propia clave: no requiere el permiso de usuarios.
userRoutes.put("/me/password", async (c) => {
  const { passwordHash } = await readJson(c, selfPasswordSchema);
  const me = c.get("user");
  const token = getCookie(c, cookieName(c.env)) ?? "";
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3").bind(passwordHash, new Date().toISOString(), me.id),
    // Cierra todas las demás sesiones del usuario (por si alguien más tenía la clave anterior).
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2").bind(me.id, await sha256Hex(token)),
  ]);
  return c.json({ ok: true });
});

userRoutes.use("/users", requirePermission("users"));
userRoutes.use("/users/*", requirePermission("users"));

userRoutes.get("/users", async (c) => {
  const res = await c.env.DB.prepare(`SELECT ${COLS} FROM users ORDER BY role = 'root' DESC, name COLLATE NOCASE`).all<Row>();
  return c.json({ users: res.results.map(toApi), permissions: PERMISSIONS });
});

userRoutes.post("/users", async (c) => {
  const actor = c.get("user");
  const body = await readJson(c, createUserSchema);
  assertGrantable(actor, body.permissions);
  const ts = new Date().toISOString();
  const id = randomId();
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, role, permissions, password_hash, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'staff', ?4, ?5, 1, ?6, ?6)`,
    )
      .bind(id, body.email, body.name, JSON.stringify(body.permissions), body.passwordHash, ts)
      .run();
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes("UNIQUE")) {
      throw new HttpError(409, "email_taken", "Ya existe un usuario con ese correo", { email: "Ya existe un usuario con ese correo" });
    }
    throw err;
  }
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM users WHERE id = ?1`).bind(id).first<Row>();
  return c.json({ user: toApi(row!) }, 201);
});

userRoutes.patch("/users/:id", async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  if (!ID_RE.test(id)) throw new HttpError(404, "not_found", "Usuario no encontrado");
  const body = await readJson(c, updateUserSchema);
  const target = await c.env.DB.prepare(`SELECT ${COLS} FROM users WHERE id = ?1`).bind(id).first<Row>();
  if (!target) throw new HttpError(404, "not_found", "Usuario no encontrado");

  if (target.role === "root" && actor.role !== "root") throw new HttpError(403, "forbidden", "No puedes modificar al administrador principal");
  if (target.role === "root" && (body.active === false || body.permissions)) {
    throw new HttpError(400, "root_protected", "El administrador principal siempre está activo y tiene todos los permisos");
  }
  if (target.id === actor.id && body.active === false) throw new HttpError(400, "self_deactivate", "No puedes desactivar tu propia cuenta");
  if (body.permissions) {
    assertGrantable(actor, body.permissions);
    // Un gestor de usuarios no puede quitar el permiso "users" que otro recibió del root.
    if (actor.role !== "root" && parsePermissions(target.permissions, target.role).includes("users")) {
      throw new HttpError(403, "forbidden", "Solo el administrador principal puede cambiar los permisos de otro gestor de usuarios");
    }
  }

  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (body.name !== undefined) (sets.push("name = ?"), binds.push(body.name));
  if (body.permissions !== undefined) (sets.push("permissions = ?"), binds.push(JSON.stringify(body.permissions)));
  if (body.active !== undefined) (sets.push("active = ?"), binds.push(body.active ? 1 : 0));
  if (body.passwordHash !== undefined) (sets.push("password_hash = ?"), binds.push(body.passwordHash));
  if (!sets.length) throw new HttpError(400, "validation_error", "Nada que actualizar");
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());

  const stmts = [c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id)];
  // Desactivar o cambiar la clave cierra todas las sesiones de ese usuario.
  if (body.active === false || body.passwordHash !== undefined) {
    stmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id));
  }
  await c.env.DB.batch(stmts);
  const row = await c.env.DB.prepare(`SELECT ${COLS} FROM users WHERE id = ?1`).bind(id).first<Row>();
  return c.json({ user: toApi(row!) });
});

userRoutes.delete("/users/:id", async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  if (!ID_RE.test(id)) throw new HttpError(404, "not_found", "Usuario no encontrado");
  const target = await c.env.DB.prepare("SELECT id, role, permissions FROM users WHERE id = ?1").bind(id).first<Row>();
  if (!target) throw new HttpError(404, "not_found", "Usuario no encontrado");
  if (target.role === "root") throw new HttpError(400, "root_protected", "El administrador principal no se puede eliminar");
  if (target.id === actor.id) throw new HttpError(400, "self_delete", "No puedes eliminar tu propia cuenta");
  if (actor.role !== "root" && parsePermissions(target.permissions, target.role).includes("users")) {
    throw new HttpError(403, "forbidden", "Solo el administrador principal puede eliminar a otro gestor de usuarios");
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(id),
  ]);
  return c.json({ ok: true });
});
