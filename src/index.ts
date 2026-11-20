import { Hono } from "hono";
import type { AppEnv } from "./env";
import { HttpError } from "./lib/http";
import { noStore, originGuard, proxyGuard, securityHeaders } from "./middleware/security";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.use("*", noStore);
app.use("/api/*", proxyGuard);
app.use("/api/*", originGuard);

app.route("/api", publicRoutes);
app.route("/api/admin", adminRoutes);

app.notFound((c) => c.json({ error: { code: "not_found", message: "No encontrado" } }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    if (err.headers) for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return c.json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } }, err.status);
  }
  // No se filtra información interna al cliente.
  console.error("unhandled_error", err instanceof Error ? err.name : "unknown");
  return c.json({ error: { code: "internal_error", message: "Ocurrió un error inesperado" } }, 500);
});

export default app;
