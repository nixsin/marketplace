import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed, self-describing access tokens for the private source maps.
 *
 * A single shared static secret would have been simpler and worse: it says
 * nothing about who is using it, cannot expire, and the only way to revoke one
 * person's access is to rotate it for everybody. These tokens carry who minted
 * them, a distinct id per grant, and an expiry the server enforces.
 *
 * Stateless on purpose. Verification needs only the signing key, so nothing
 * has to be stored, replicated or cleaned up -- which matters because the
 * thing being protected is a debugging aid, and a debugging aid that needs its
 * own datastore does not get used.
 *
 * THIS FILE LIVES IN A SUBPATH EXPORT, not the package index, and that is
 * load-bearing. `@medinstru/config`'s main entry is imported by client
 * components; pulling `node:crypto` into it would break the browser build. The
 * client never imports this path.
 *
 * Plain JS with a hand-written .d.ts, for the reason the package README gives:
 * apps/web compiles it as TypeScript while scripts/ import it as plain Node
 * ESM with no build step.
 */

/** Bumped if the payload shape or signing scheme ever changes. */
const VERSION = "v1";

/** Name only, never a value -- this package is committed. */
export const SOURCEMAP_SIGNING_KEY_ENV = "SOURCEMAP_SIGNING_KEY";

/** Two hours. Long enough for a debugging session, short enough to forget. */
export const SOURCEMAP_TOKEN_DEFAULT_TTL_SECONDS = 2 * 60 * 60;

/**
 * A day. Not a policy so much as a guard against `--ttl 8760h` typed once and
 * living in someone's browser for a year.
 */
export const SOURCEMAP_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(body, key) {
  return createHmac("sha256", key).update(body).digest();
}

/**
 * Mints a token.
 *
 * `issuer` is whoever is asking for access -- an email, a username, anything
 * that identifies a person in your own logs. It is signed, so it cannot be
 * edited after the fact, but it is NOT secret: anyone holding the token can
 * read it. That is deliberate; the token says who it belongs to.
 */
export function signSourcemapToken({
  issuer,
  key,
  ttlSeconds = SOURCEMAP_TOKEN_DEFAULT_TTL_SECONDS,
  now = Date.now(),
}) {
  if (!issuer || typeof issuer !== "string") {
    throw new Error("issuer is required — a token that identifies nobody defeats the point");
  }
  if (!key) {
    throw new Error(`${SOURCEMAP_SIGNING_KEY_ENV} is not set`);
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive number");
  }
  if (ttlSeconds > SOURCEMAP_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(
      `ttlSeconds may not exceed ${SOURCEMAP_TOKEN_MAX_TTL_SECONDS} (24h)`,
    );
  }

  const issuedAt = Math.floor(now / 1000);
  const payload = {
    iss: issuer,
    // Distinct per grant. Two tokens for the same person are still tellable
    // apart in the access log, which is what makes "who was reading source
    // maps at 3am" answerable.
    sid: randomBytes(9).toString("base64url"),
    iat: issuedAt,
    exp: issuedAt + Math.floor(ttlSeconds),
  };

  const body = `${VERSION}.${b64url(JSON.stringify(payload))}`;
  return { token: `${body}.${b64url(sign(body, key))}`, payload };
}

/**
 * Verifies a token, returning its payload or a reason it failed.
 *
 * Never throws for an invalid token -- a caller that has to distinguish
 * "malformed" from "thrown" ends up with a try/catch that swallows real
 * errors. The reason is for the SERVER LOG, never for the response: telling a
 * caller whether their signature was wrong or merely expired hands them a
 * probing oracle.
 */
export function verifySourcemapToken({ token, key, now = Date.now() }) {
  if (!key) return { ok: false, reason: "signing key not configured" };
  if (!token || typeof token !== "string") return { ok: false, reason: "no token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [version, encodedPayload, signature] = parts;
  if (version !== VERSION) return { ok: false, reason: `unsupported version ${version}` };

  const expected = sign(`${version}.${encodedPayload}`, key);
  let presented;
  try {
    presented = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  // Length is checked first because timingSafeEqual throws on a mismatch --
  // and a signature of the wrong length is not a timing signal worth
  // protecting, since the expected length is fixed and public.
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return { ok: false, reason: "bad signature" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "unreadable payload" };
  }

  // Checked AFTER the signature, deliberately: an unsigned payload's claims
  // are attacker-controlled, and reading them first would mean acting on
  // values nothing has vouched for.
  if (typeof payload?.exp !== "number" || payload.exp * 1000 <= now) {
    return { ok: false, reason: "expired", payload };
  }
  if (typeof payload.iss !== "string" || !payload.iss) {
    return { ok: false, reason: "no issuer" };
  }

  return { ok: true, payload };
}
