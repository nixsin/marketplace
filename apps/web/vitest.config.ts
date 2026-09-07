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
      // WIDENED from src/components/** to include src/lib and src/app.
      //
      // The old scope was honest when it was written -- components were the
      // only tested surface. It stopped being honest once the scenario audit
      // took api.ts and catalog-seo.ts to 100%: those numbers were produced by
      // passing --coverage.include BY HAND, so nothing kept them there, and a
      // regression in the code this repo most recently hardened would not have
      // shown up in any run.
      //
      // It also left src/app entirely unmeasured, which meant "are the pages
      // tested?" could only be answered by listing files and guessing. The
      // point of measuring is to stop guessing.
      //
      // ui/** stays excluded: shadcn's vendored primitives are not code we
      // own, which is a scope decision rather than a gap being papered over.
      include: ["src/components/**", "src/lib/**", "src/app/**"],
      exclude: ["src/components/ui/**", "src/**/*.spec.*"],
      // Real numbers, not aspirational ones, and a RATCHET rather than a
      // target: set just under what the suite actually achieves, so a
      // regression fails while ordinary work does not.
      //
      // They came DOWN from 95 when the scope widened, and that is not a drop
      // in quality -- it is the cost of measuring more. Two files report 0%
      // while being genuinely well tested, because their tests spawn a real
      // server and exercise them IN ANOTHER PROCESS, which v8 cannot attribute
      // back here:
      //
      //   sourcemaps/[file]/route.ts   13 tests in test/sourcemap-access.spec
      //   [locale]/layout.tsx          rendered during SSR by the same suites
      //
      // They stay in scope anyway. Excluding them would make the number
      // prettier and hide the one thing worth knowing: that a 0% here means
      // "not measured in this process", not "not tested" -- a distinction the
      // next person needs, and one an exclusion would erase.
      thresholds: {
        statements: 90,
        lines: 92,
        functions: 91,
        branches: 90,
      },
    },
  },
});
