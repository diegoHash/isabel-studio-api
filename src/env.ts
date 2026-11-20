export interface Bindings {
  DB: D1Database;
  ENVIRONMENT?: string;
  /** Orígenes (separados por coma) autorizados a enviar peticiones que modifican datos. */
  ALLOWED_ORIGINS?: string;
  /** Hash PBKDF2 de la clave del panel. Secreto de Cloudflare. */
  ADMIN_PASSWORD_HASH?: string;
  /** Secreto compartido con el proxy de Vercel. Secreto de Cloudflare. */
  PROXY_SECRET?: string;
}

export interface Variables {
  clientIp: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
