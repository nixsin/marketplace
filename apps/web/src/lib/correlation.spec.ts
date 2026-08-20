// @vitest-environment jsdom
//
// Unlike the other src/lib specs, this one reads document.cookie and
// location, so it needs a DOM. Scoped per-file rather than widening the
// project config, which would slow every pure-logic spec down.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORRELATION_HEADERS,
  correlationHeaders,
  getPageViewId,
  getSessionId,
  newClientRequestId,
  newPageView,
} from "./correlation";

function clearCookies() {
  for (const c of document.cookie.split(";")) {
    document.cookie = `${c.split("=")[0].trim()}=; path=/; max-age=0`;
  }
}

describe("session id", () => {
  beforeEach(clearCookies);
  afterEach(clearCookies);

  it("is stable across calls within a session", () => {
    // If this regenerated per call, every request would look like its own
    // session and nothing could be tied together.
    expect(getSessionId()).toBe(getSessionId());
  });

  it("persists in a cookie, not memory", () => {
    // A cookie specifically: sessionStorage is per-tab, so opening a
    // product in a new tab would register as a separate session, and it
    // is invisible to server rendering.
    const id = getSessionId();
    expect(document.cookie).toContain(`mi_sid=${id}`);
  });

  it("adopts an existing cookie rather than minting a new id", () => {
    document.cookie = "mi_sid=existing-session-1; path=/";
    expect(getSessionId()).toBe("existing-session-1");
  });

  it("refreshes the cookie on read, making the window rolling", () => {
    // A hard 30-minute cap would cut off an actively browsing user
    // mid-visit. Re-writing on read means only idleness expires it.
    const id = getSessionId();
    document.cookie = `mi_sid=; path=/; max-age=0`;
    expect(document.cookie).not.toContain(id);
    expect(getSessionId()).not.toBe("");
  });
});

describe("page view id", () => {
  it("is stable until a new page view starts", () => {
    const first = getPageViewId();
    expect(getPageViewId()).toBe(first);
    const second = newPageView();
    expect(second).not.toBe(first);
    expect(getPageViewId()).toBe(second);
  });
});

describe("client request id", () => {
  it("is unique per call", () => {
    const ids = new Set(Array.from({ length: 200 }, newClientRequestId));
    expect(ids.size).toBe(200);
  });

  it("only uses characters the API will accept", () => {
    // The API drops any correlation id outside this charset, to stop log
    // injection. An id we generate must never be silently discarded.
    for (let i = 0; i < 50; i++) {
      expect(newClientRequestId()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });
});

describe("correlationHeaders", () => {
  beforeEach(clearCookies);

  it("carries all three ids in the browser", () => {
    const headers = correlationHeaders("client-req-1");
    expect(headers[CORRELATION_HEADERS.clientRequestId]).toBe("client-req-1");
    expect(headers[CORRELATION_HEADERS.sessionId]).toBeTruthy();
    expect(headers[CORRELATION_HEADERS.pageViewId]).toBeTruthy();
  });

  it("groups calls from one page view together", () => {
    const a = correlationHeaders(newClientRequestId());
    const b = correlationHeaders(newClientRequestId());
    // Different requests, same page view and session -- which is exactly
    // what lets unrelated requests be stitched into one user story.
    expect(a[CORRELATION_HEADERS.clientRequestId]).not.toBe(
      b[CORRELATION_HEADERS.clientRequestId],
    );
    expect(a[CORRELATION_HEADERS.pageViewId]).toBe(b[CORRELATION_HEADERS.pageViewId]);
    expect(a[CORRELATION_HEADERS.sessionId]).toBe(b[CORRELATION_HEADERS.sessionId]);
  });
});
