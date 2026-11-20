import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "test",
            ALLOWED_ORIGINS: "https://sitio.test,http://localhost:3000",
            PROXY_SECRET: "test-proxy-secret-0123456789abcdef",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      include: ["test/**/*.test.ts"],
    },
  };
});
