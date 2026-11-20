export interface Bindings {
  DB: D1Database;
  ENVIRONMENT?: string;
  /** Orígenes (separados por coma) autorizados a enviar peticiones que modifican datos. */
  ALLOWED_ORIGINS?: string;
  /** Secreto compartido con el proxy de Vercel. Secreto de Cloudflare. */
  PROXY_SECRET?: string;
}

export const PERMISSIONS = ["appointments", "schedule", "users"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "root" | "staff";
  permissions: Permission[];
}

export interface Variables {
  clientIp: string;
  user: AuthUser;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
