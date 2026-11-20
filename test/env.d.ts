import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      ENVIRONMENT?: string;
      ALLOWED_ORIGINS?: string;
      PROXY_SECRET?: string;
      ADMIN_PASSWORD_HASH?: string;
    }
  }
}
export {};
