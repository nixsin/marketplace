// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ServiceWorkerRegistration } from "./service-worker-registration";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  vi.restoreAllMocks();
});

describe("ServiceWorkerRegistration", () => {
  it("renders nothing", () => {
    const { container } = render(<ServiceWorkerRegistration />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not register outside production (dev/test builds)", () => {
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register },
      configurable: true,
    });

    render(<ServiceWorkerRegistration />);

    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing when the browser has no serviceWorker support, even in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => render(<ServiceWorkerRegistration />)).not.toThrow();
  });

  it("registers /sw.js in production when supported", () => {
    vi.stubEnv("NODE_ENV", "production");
    const register = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register },
      configurable: true,
    });

    render(<ServiceWorkerRegistration />);

    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("logs, rather than throws, if registration fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const failure = new Error("nope");
    const register = vi.fn().mockRejectedValue(failure);
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register },
      configurable: true,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<ServiceWorkerRegistration />);

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "Service worker registration failed:",
        failure,
      ),
    );
  });
});
