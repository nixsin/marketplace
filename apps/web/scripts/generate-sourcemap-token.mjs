#!/usr/bin/env node
/**
 * Mints a source-map access token.
 *
 *   pnpm --filter web sourcemap:token
 *   pnpm --filter web sourcemap:token -- --as alice@example.com --ttl 30m
 *
 * The token identifies who minted it, carries a distinct id per grant, and
 * expires. See packages/config/src/sourcemap-token.js for why it is signed
 * rather than a shared static secret.
 *
 * The signing key is read from the environment BY NAME and never accepted as
 * an argument -- an argument would land in shell history, in `ps` output, and
 * in any CI log that echoes the command.
 */
import { execFileSync } from "node:child_process";
import {
  SOURCEMAP_SIGNING_KEY_ENV,
  SOURCEMAP_TOKEN_DEFAULT_TTL_SECONDS,
  SOURCEMAP_TOKEN_MAX_TTL_SECONDS,
  signSourcemapToken,
} from "@medinstru/config/sourcemap-token";

/** `90s`, `30m`, `2h` or a bare number of seconds. */
function parseTtl(value) {
  if (!value) return SOURCEMAP_TOKEN_DEFAULT_TTL_SECONDS;
  const match = /^(\d+)([smh]?)$/.exec(value.trim());
  if (!match) {
    throw new Error(`could not read --ttl "${value}" — try 30m, 2h, or a number of seconds`);
  }
  const n = Number(match[1]);
  return n * { s: 1, m: 60, h: 3600, "": 1 }[match[2]];
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Who is asking. Defaults to the git identity, because the person running
 * this in a checkout is the person whose name belongs in the access log --
 * and because a default that requires no thought is a default people keep.
 */
function resolveIssuer() {
  const explicit = arg("as");
  if (explicit) return explicit;
  try {
    return execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const key = process.env[SOURCEMAP_SIGNING_KEY_ENV];
if (!key) {
  console.error(
    `\n  ${SOURCEMAP_SIGNING_KEY_ENV} is not set.\n\n` +
      `  It is the same value the running service uses to verify tokens, so\n` +
      `  export it in your shell rather than passing it here -- an argument\n` +
      `  would land in shell history and in \`ps\` output.\n\n` +
      `  To create one for the first time:\n` +
      `    node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"\n\n` +
      `  Then set it on the web service and export it locally.\n`,
  );
  process.exit(1);
}

const issuer = resolveIssuer();
if (!issuer) {
  console.error(
    `\n  Could not work out who you are.\n\n` +
      `  Set a git identity, or pass one:  --as you@example.com\n\n` +
      `  A token that identifies nobody defeats the point -- the access log\n` +
      `  would record that someone read the source maps, and nothing more.\n`,
  );
  process.exit(1);
}

let ttlSeconds;
try {
  ttlSeconds = parseTtl(arg("ttl"));
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
}

let minted;
try {
  minted = signSourcemapToken({ issuer, key, ttlSeconds });
} catch (error) {
  console.error(
    `\n  ${error.message}\n` +
      (ttlSeconds > SOURCEMAP_TOKEN_MAX_TTL_SECONDS
        ? `  The ceiling is ${SOURCEMAP_TOKEN_MAX_TTL_SECONDS / 3600}h.\n`
        : ""),
  );
  process.exit(1);
}

const { token, payload } = minted;
const expires = new Date(payload.exp * 1000);
const site = process.env.NEXT_PUBLIC_SITE_URL || "https://your-site";

process.stdout.write(
  `\n  Source-map access token\n\n` +
    `    for      ${payload.iss}\n` +
    `    grant    ${payload.sid}\n` +
    `    expires  ${expires.toISOString()}  (in ${Math.round(ttlSeconds / 60)} min)\n\n` +
    `  Paste this in the browser console on ${site} :\n\n` +
    `    document.cookie = "mi_srcmap=${token}; path=/; SameSite=Strict; Secure"\n\n` +
    `  Then open devtools. Source maps resolve until it expires, after which\n` +
    `  they stop resolving on their own -- there is nothing to revoke.\n\n` +
    `  The token identifies you in the server's access log. Do not share it;\n` +
    `  anything done with it is recorded against your name.\n\n`,
);
