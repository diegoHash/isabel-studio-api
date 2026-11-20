import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { HttpError, parseQuery } from "../lib/http";
import { emailField } from "../lib/validation";

/**
 * Rutas SOLO para el servidor de Vercel (ya protegidas por el secreto del proxy). El proxy nunca las
 * expone al navegador. Sirven para que Vercel verifique la clave con Argon2id, algo que el plan Free
 * de Workers no puede hacer por su límite de CPU.
 */
export const internalRoutes = new Hono<AppEnv>();

internalRoutes.get("/credentials", async (c) => {
  const q = parseQuery(c, z.object({ email: emailField }));
  const row = await c.env.DB.prepare("SELECT password_hash FROM users WHERE email = ?1 AND active = 1").bind(q.email).first<{ password_hash: string }>();
  if (!c.req.header("x-proxy-secret")) throw new HttpError(403, "forbidden", "Acceso denegado");
  return c.json({ hash: row?.password_hash ?? null });
});
