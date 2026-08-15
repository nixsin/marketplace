import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// RTL doesn't auto-register its cleanup with Vitest's test runner the way
// it does with Jest — without this, each test's rendered tree leaks into
// the next test's DOM (exactly what caused the first version of this file
// to fail: two <select>s found where one was expected).
afterEach(() => {
  cleanup();
});
