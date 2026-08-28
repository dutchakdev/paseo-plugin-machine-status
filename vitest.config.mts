import { URL, fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Paseo injects `@getpaseo/plugin/server` at runtime, so it has no entry in
 * node_modules. Tests alias it to a local stub in order to import the shared
 * contracts and exercise the real handlers outside the daemon.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@getpaseo/plugin/server": fileURLToPath(
        new URL("./tests/stubs/paseo-plugin-server.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
