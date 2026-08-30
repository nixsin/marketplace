import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  SOURCEMAP_TOKEN_MAX_TTL_SECONDS,
  signSourcemapToken,
  verifySourcemapToken,
} from "@medinstru/config/sourcemap-token";

const KEY = "signing-key-for-the-suite-only-long-enough";

/**
 * The token format itself, away from HTTP.
 *
 * `sourcemap-access.spec.ts` proves the route refuses the wrong tokens over
 * real HTTP; these cover the shapes that are awkward to drive through a
 * server -- clock boundaries, refusal reasons, and the properties that make
 * an access log worth reading.
 */
describe("sourcemap tokens", () => {
  it("carries who minted it, readably", () => {
    // Readable on purpose: the token says whose it is, and the signature is
    // what stops that being edited.
    const { token, payload } = signSourcemapToken({ issuer: "a@example.com", key: KEY });
    const decoded = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    ) as { iss: string };

    expect(decoded.iss).toBe("a@example.com");
    expect(payload.iss).toBe("a@example.com");
  });

  it("gives two grants to the same person DIFFERENT ids", () => {
    // Otherwise "who was reading source maps at 3am" is answerable only down
    // to the person, not the session -- and a leaked token could not be told
    // apart from a fresh one.
    const a = signSourcemapToken({ issuer: "a@example.com", key: KEY });
    const b = signSourcemapToken({ issuer: "a@example.com", key: KEY });

    expect(a.payload.sid).not.toBe(b.payload.sid);
    expect(a.token).not.toBe(b.token);
  });

  it("accepts a live token and rejects one a second past expiry", () => {
    const now = Date.now();
    const { token } = signSourcemapToken({ issuer: "a@example.com", key: KEY, ttlSeconds: 60, now });

    expect(verifySourcemapToken({ token, key: KEY, now: now + 59_000 }).ok).toBe(true);
    expect(verifySourcemapToken({ token, key: KEY, now: now + 61_000 }).ok).toBe(false);
  });

  it("refuses a signature made with a different key", () => {
    const { token } = signSourcemapToken({ issuer: "a@example.com", key: "a-different-key-that-is-also-long-enough" });
    const result = verifySourcemapToken({ token, key: KEY });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("bad signature");
  });

  it("checks the signature BEFORE reading any claim", () => {
    // A payload nothing has vouched for is attacker-controlled. An
    // implementation that read `exp` first would be acting on a value the
    // caller chose -- so a forged token must fail on the signature, never on
    // its own claims.
    const forged = Buffer.from(
      JSON.stringify({ iss: "attacker", sid: "x", iat: 0, exp: 0 }),
    ).toString("base64url");
    const result = verifySourcemapToken({
      token: `v1.${forged}.${Buffer.from("nonsense").toString("base64url")}`,
      key: KEY,
    });

    expect(result.ok).toBe(false);
    // "expired" here would mean the claim was read first.
    expect(result.ok === false && result.reason).toBe("bad signature");
  });

  it("fails closed when no key is configured", () => {
    const { token } = signSourcemapToken({ issuer: "a@example.com", key: KEY });

    expect(verifySourcemapToken({ token, key: undefined }).ok).toBe(false);
  });

  it("refuses to mint a token that identifies nobody", () => {
    expect(() => signSourcemapToken({ issuer: "", key: KEY })).toThrow(/issuer/i);
  });

  it("caps the lifetime", () => {
    // Not a policy so much as a guard against a long TTL typed once and
    // living in a browser for a year.
    expect(() =>
      signSourcemapToken({
        issuer: "a@example.com",
        key: KEY,
        ttlSeconds: SOURCEMAP_TOKEN_MAX_TTL_SECONDS + 1,
      }),
    ).toThrow();
  });

  it("refuses a signed payload missing sid, rather than logging undefined", () => {
    // The type declaration promises sid and iat are present. Validating only
    // exp and iss meant a correctly signed payload without them returned
    // ok:true and the route logged `sid: undefined` -- worse than refusing,
    // because it reads as a successful access with no session to attribute.
    const body = `v1.${Buffer.from(
      JSON.stringify({ iss: "a@example.com", iat: 1, exp: 4102444800 }),
    ).toString("base64url")}`;
    const sig = createHmac("sha256", KEY).update(body).digest("base64url");

    const result = verifySourcemapToken({ token: `${body}.${sig}`, key: KEY });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("incomplete payload");
  });

  it("refuses a key short enough to guess", () => {
    // Possession of the key mints arbitrary tokens, so this is an
    // authentication boundary -- a README recommendation cannot stop a
    // one-character placeholder becoming production's real key.
    expect(() => signSourcemapToken({ issuer: "a@example.com", key: "x" })).toThrow(
      /at least/i,
    );
  });

  it.each([0.5, 1.5, 0.001])("refuses a fractional ttl of %p", (ttlSeconds) => {
    // Math.floor(0.5) is 0 -- a token already expired the moment it is
    // minted. Any other fraction silently shortens the requested life.
    expect(() =>
      signSourcemapToken({ issuer: "a@example.com", key: KEY, ttlSeconds }),
    ).toThrow(/whole number/i);
  });

  it.each(["", "not-a-token", "v1.only-two", "v2.abc.def"])(
    "refuses the malformed token %p without throwing",
    (token) => {
      // Never throws for a bad token: a caller forced into try/catch ends up
      // swallowing real errors alongside invalid input.
      expect(() => verifySourcemapToken({ token, key: KEY })).not.toThrow();
      expect(verifySourcemapToken({ token, key: KEY }).ok).toBe(false);
    },
  );
});
