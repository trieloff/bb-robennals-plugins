import path from "node:path";
import { defineConfig } from "vitest/config";

// The `@/*` alias mirrors tsconfig's paths so tests resolve the vendored UI
// components the same way `bb plugin build` does.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
  test: { include: ["**/*.test.ts", "**/*.test.tsx"], exclude: ["node_modules/**"] },
});
