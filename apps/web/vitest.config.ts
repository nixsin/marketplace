import {
  DEV_API_URL,
  DEV_BLOB_BASE_URL,
  DEV_SITE_URL,
} from "@medinstru/config";
import { DEPLOY_ENVIRONMENT } from "@medinstru/config/env-contract";
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
    // The test environment declares every variable, like docker-compose.yml
    // and ci.yml do -- there is one variable list and every environment
    // declares all of it. Values come from @medinstru/config rather than
    // literals, so "the localhost API" has one definition instead of six.
    //
    // Several specs in test/ boot a real `next start`, which runs the
    // environment check; without these it would refuse to start.
    env: {
      APP_ENV: DEPLOY_ENVIRONMENT.TEST,
      NEXT_PUBLIC_API_URL: DEV_API_URL,
      NEXT_PUBLIC_SITE_URL: DEV_SITE_URL,
      NEXT_PUBLIC_BLOB_BASE_URL: DEV_BLOB_BASE_URL,
      // Empty: source maps unavailable. The route fails closed, so this is
      // the safe state rather than a broken one.
      SOURCEMAP_SIGNING_KEY: "",
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
