import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Exercises the REAL public/sw.js source, not a copy of its logic. A
// service worker is a static file the browser loads directly -- it cannot
// be imported, so the only two ways to test it are a full browser (the
// e2e suite, which owns the cache-isolation/security behaviour) or this:
// evaluate the actual shipped bytes against stub globals.
//
// The gap this closes is specific. The e2e suite drives a real worker
// against a real server, so it covers the paths that succeed. It cannot
// easily force "the network fails and nothing is cached" -- the branch
// with no coverage at all before this file.
//
// Scope, stated honestly because the tempting claim is false: a promise
// that rejects and one that resolves to a non-Response BOTH make
// respondWith() yield a network error, so none of this changes what the
// page observes. These tests pin the worker's internal contract -- which
// value comes back on each branch, and that a failing cache write neither
// loses the response nor leaks an unhandled rejection.

const SW_SOURCE = readFileSync(
  join(__dirname, "..", "public", "sw.js"),
  "utf8",
);

interface LoadedWorker {
  fetchHandler: (event: FakeFetchEvent) => void;
}

interface FakeFetchEvent {
  request: unknown;
  respondWith: (value: Promise<unknown>) => void;
}

/** Evaluates the real sw.js with injected globals and returns its handlers. */
function loadWorker(opts: {
  cached?: unknown;
  fetchImpl: () => Promise<unknown>;
  cachePut?: () => Promise<void>;
}): LoadedWorker {
  const listeners: Record<string, (event: never) => void> = {};
  const self = {
    addEventListener: (type: string, handler: (event: never) => void) => {
      listeners[type] = handler;
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async () => ({
      match: async () => opts.cached,
      put: opts.cachePut ?? (async () => {}),
    }),
    keys: async () => [],
    delete: async () => true,
  };

   
  new Function("self", "caches", "fetch", "URL", SW_SOURCE)(
    self,
    caches,
    opts.fetchImpl,
    URL,
  );

  const fetchHandler = listeners.fetch;
  if (!fetchHandler) throw new Error("sw.js registered no fetch listener");
  return { fetchHandler: fetchHandler as (event: FakeFetchEvent) => void };
}

/** A page navigation -- the one request kind the worker still intercepts. */
function navigationRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    url: "https://laxair.shop/en",
    mode: "navigate",
    credentials: "include",
    headers: { has: () => false },
    ...overrides,
  };
}

/** A GraphQL read shaped exactly like the one src/lib/api.ts issues. */
function graphqlRequest(overrides: Record<string, unknown> = {}) {
  const query =
    "query ProductsPaged($page: Int, $pageSize: Int) { productsPaged(page: $page, pageSize: $pageSize) { items { id } } }";
  return {
    method: "GET",
    url: `https://api.laxair.shop/graphql?query=${encodeURIComponent(query)}`,
    mode: "cors",
    credentials: "omit",
    headers: { has: () => false },
    ...overrides,
  };
}

/** Runs the worker's fetch handler and returns whatever it responded with. */
function respond(worker: LoadedWorker, request: unknown) {
  let responded: Promise<unknown> | undefined;
  worker.fetchHandler({
    request,
    respondWith: (value) => {
      responded = value;
    },
  });
  return responded;
}

describe("service worker fetch handling", () => {
  it("propagates the network error instead of discarding it on a cold cache", async () => {
    // The old form returned `undefined` here, throwing away the reason the
    // fetch failed. The browser surfaces a network error either way, so
    // this is about the cause remaining inspectable in the worker rather
    // than about what the user sees.
    const worker = loadWorker({
      cached: undefined,
      fetchImpl: () => Promise.reject(new Error("network down")),
    });

    const responded = respond(worker, navigationRequest());
    expect(responded, "the worker should have intercepted this request").toBeDefined();
    await expect(responded).rejects.toThrow("network down");
  });

  it("still serves the cached copy when the network fails and one exists", async () => {
    // The other half of the same branch: falling back is the entire point
    // of stale-while-revalidate, and the fix above must not cost it.
    const cached = { tag: "CACHED" };
    const worker = loadWorker({
      cached,
      fetchImpl: () => Promise.reject(new Error("network down")),
    });

    await expect(respond(worker, navigationRequest())).resolves.toBe(cached);
  });

  it("delivers the network response even if writing it to the cache fails", async () => {
    // A cache write must never delay or fail delivery of a response we
    // already hold. Verified directly before relying on it: because the
    // put is neither awaited nor returned, its rejection cannot reach the
    // chain's catch -- so the risk is an unhandled rejection, not a lost
    // response. This pins both halves of that.
    const response = { ok: true, tag: "NETWORK", clone: () => ({}) };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    // try/finally, because an assertion below throwing would otherwise
    // leak a process-wide listener into every later test and into
    // watch-mode runs -- a failure that shows up somewhere else entirely.
    try {
      const worker = loadWorker({
        cached: undefined,
        fetchImpl: () => Promise.resolve(response),
        cachePut: () => Promise.reject(new Error("QuotaExceededError")),
      });

      await expect(respond(worker, navigationRequest())).resolves.toBe(response);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled, "a rejected cache.put must not surface as unhandled").not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("NEVER intercepts a GraphQL read, whatever shape it arrives in", () => {
    // The standing rule, pinned. This worker used to allowlist the exact
    // ProductsPaged query text and serve it stale-while-revalidate, with
    // careful credentials and Authorization checks guarding a cache that
    // cannot partition by user identity. All of that is deleted: no API
    // response is cached here at all, so there is nothing to guard.
    //
    // Asserted across the shapes the old allowlist reasoned about, so a
    // reintroduction along ANY of those paths fails here rather than
    // passing because it happened to pick a different one.
    const worker = loadWorker({
      cached: { tag: "MUST NOT BE SERVED" },
      fetchImpl: () => Promise.reject(new Error("should never be called")),
    });

    for (const request of [
      graphqlRequest(),
      graphqlRequest({ credentials: "include" }),
      graphqlRequest({ headers: { has: () => true } }),
      graphqlRequest({
        url: "https://api.laxair.shop/graphql?query=" + encodeURIComponent("{me{id}}"),
      }),
      graphqlRequest({ url: "https://laxair.shop/graphql?query=%7Bme%7Bid%7D%7D" }),
    ]) {
      expect(
        respond(worker, request),
        `the worker must not intercept ${String((request as { url: string }).url).slice(0, 60)}`,
      ).toBeUndefined();
    }
  });

  it("intercepts NOTHING but navigations", () => {
    // The complement of the rule above, stated as a property rather than a
    // list: an image, a stylesheet and a same-origin data fetch are all
    // left to the HTTP cache. Written this way so a future handler that
    // widens beyond navigations fails here even for a kind nobody thought
    // to enumerate.
    const worker = loadWorker({
      cached: { tag: "MUST NOT BE SERVED" },
      fetchImpl: () => Promise.reject(new Error("should never be called")),
    });

    for (const mode of ["cors", "no-cors", "same-origin"]) {
      expect(
        respond(worker, navigationRequest({ mode })),
        `mode "${mode}" must not be intercepted`,
      ).toBeUndefined();
    }
  });

  it("still intercepts a real navigation, so the shell keeps working", () => {
    // The other direction. Deleting API caching must not quietly delete
    // the worker's actual job -- painting the shell instantly on a repeat
    // visit, which is why this file exists on a free tier that spins down.
    const cached = { tag: "SHELL" };
    const worker = loadWorker({
      cached,
      fetchImpl: () => Promise.reject(new Error("network down")),
    });

    expect(respond(worker, navigationRequest())).toBeDefined();
  });
});
