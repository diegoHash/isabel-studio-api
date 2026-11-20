# Isabel Rojas Studio de Uñas — API

Backend de citas en **Cloudflare Workers + D1** (Hono, zod, TypeScript). Lo consume el sitio
[`isabel-studio-pwa`](https://github.com/diegoHash/isabel-studio-pwa) a través de un proxy servidor en Vercel,
por lo que el navegador nunca ve la URL ni las credenciales del backend.

## Reglas de negocio
- Zona horaria **America/Bogota**. Trabaja **lunes a sábado**; domingos y **festivos de Colombia** (calculados, Ley Emiliani) cerrados.
- Horas base: 8, 9, 10, 11, 13, 14, 15, 16 y 17 h (configurables desde el panel).
- Antelación mínima 1 h, ventana de reserva de 60 días, una cita por franja (índice único en D1 → sin dobles reservas).
- Una cita puede incluir **varios servicios** (carrito); guarda el detalle y el total, y ocupa una sola hora.
- Estados de cita: `pendiente` y `atendida`.
- Usuarios del panel en D1: un **root** (no se puede borrar ni degradar) y usuarios con permisos `appointments`, `schedule` y `users`. Anti-escalada: solo el root da `users`.
- El admin puede habilitar/deshabilitar días y horas puntuales (incluso abrir un domingo o una hora extra).

## Seguridad
| Riesgo | Mitigación |
|---|---|
| CSRF | Cookie `HttpOnly; SameSite=Strict` (`__Host-` en prod) + verificación de `Origin` contra `ALLOWED_ORIGINS` + solo `application/json` |
| XSS | Validación estricta con zod (`strictObject`), saneo de texto (control chars, `<`, `>`), API solo JSON con CSP `default-src 'none'` y `nosniff` |
| SQLi | Todas las consultas D1 son parametrizadas; `LIKE` con escape |
| Fuerza bruta / abuso | Rate limit en D1: login 5/15 min por IP, reservas 6/h por IP y 4/día por celular, máx. 3 citas pendientes por celular, honeypot |
| Credenciales | Clave admin como hash PBKDF2 (secreto de Cloudflare), sesiones con token aleatorio (solo se guarda su SHA-256), nada en el repo ni en el navegador |
| Acceso directo a la API | Solo acepta peticiones con `x-proxy-secret` (el proxy de Vercel); en producción sin `PROXY_SECRET` falla cerrado |

## Desarrollo
```bash
npm install
cp .dev.vars.example .dev.vars        # edita valores (archivo ignorado por git)
npm run hash-password -- "tu-clave-larga"   # pega el resultado en ADMIN_PASSWORD_HASH
npm run db:migrate:local
npm run dev                            # http://localhost:8787
npm test                               # Vitest en el runtime real de Workers (workerd)
npm run typecheck
```

## Despliegue en Cloudflare
```bash
npx wrangler login
npx wrangler d1 create isabel-studio           # copia database_id a wrangler.jsonc
npm run db:migrate:remote
# El primer usuario (root) se inserta una vez en la tabla users con un hash Argon2id (ver README del PWA).
npx wrangler secret put PROXY_SECRET            # openssl rand -hex 32 (el mismo valor va en Vercel)
# En wrangler.jsonc ajusta ALLOWED_ORIGINS con la URL final de Vercel
npm run deploy
```
Cloudflare entrega HTTPS (TLS) en `*.workers.dev` automáticamente. Como el Worker solo atiende al proxy de Vercel,
puedes desactivar `workers_dev` y usar una ruta propia cuando haya dominio.

## API (resumen)
Público: `GET /api/services`, `GET /api/availability?from&to`, `POST /api/appointments`.
Admin (cookie de sesión): `POST /api/admin/login|logout`, `GET /api/admin/me|summary|schedule|appointments|settings`,
`POST|PATCH|DELETE /api/admin/appointments[/:id]`, `PUT|DELETE /api/admin/days/:date`,
`PUT|DELETE /api/admin/slots/:date/:time`, `PUT /api/admin/settings`.
