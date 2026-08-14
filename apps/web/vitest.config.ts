import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each spec file boots its own `next start` on a fixed port — run
    // files sequentially so they don't race for the same port.
    fileParallelism: false,
  },
});
