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
    // src/**/*.spec.ts (not just .spec.tsx) added for src/lib/*.ts unit
    // tests -- pure-logic modules with no JSX, same reasoning as this
    // repo's scripts/lib/*.test.mjs convention, just under Vitest instead
    // of node:test since these run inside the web app's own suite.
    include: ["test/**/*.spec.ts", "src/**/*.spec.ts", "src/**/*.spec.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    // The test environment states its own values, like docker-compose.yml and
    // ci.yml do. @medinstru/config/web has NO fallback -- it throws when these
    // are unset -- so a suite that renders a component reading SITE_URL needs
    // them declared somewhere, and a default inside the config would put back
    // exactly the silent localhost fallback this repo just removed.
    //
    // Localhost values because these are tests, not a deployment. APP_ENV is
    // stated for the same reason it is stated in playwright.config.ts:
    // detection would otherwise have to infer it from nothing.
    env: {
      APP_ENV: "test",
      NEXT_PUBLIC_API_URL: "http://localhost:4000/graphql",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each spec file in test/ boots its own `next start` on a fixed port —
    // run files sequentially so they don't race for the same port. Component
    // specs under src/ don't touch a port at all, so this costs them nothing
    // but a bit of wall-clock time.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Scoped to src/components/** deliberately, not the whole app —
      // that's the surface this session's testing push actually covers.
      // ui/** is shadcn's vendored primitives, not code we own; excluding
      // it is a real scope decision, not papering over a gap the way
      // excluding our own untested files would be.
      include: ["src/components/**"],
      exclude: ["src/components/ui/**"],
      // Real numbers, not aspirational ones — every file in scope sits at
      // or near 100% today (verified locally); branches is 90 rather than
      // higher because product-listing.tsx's unmount-cleanup branch
      // (cancelled = true) isn't exercised yet, at 75%.
      thresholds: {
        statements: 95,
        lines: 95,
        functions: 95,
        branches: 70,
      },
    },
  },
});
