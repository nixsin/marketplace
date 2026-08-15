import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts", "src/**/*.spec.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each spec file in test/ boots its own `next start` on a fixed port —
    // run files sequentially so they don't race for the same port. Component
    // specs under src/ don't touch a port at all, so this costs them nothing
    // but a bit of wall-clock time.
    fileParallelism: false,
  },
});
