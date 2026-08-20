#!/usr/bin/env node
/**
 * Audits PRODUCTION, not the repository.
 *
 * Everything else scheduled in this repo checks the codebase: CodeQL,
 * dependency freshness, Trivy. None of them would have caught a single
 * one of the production failures listed in scripts/lib/production-audit.mjs,
 * because in every case the code was correct and the deployed
 * configuration was not.
 *
 * Usage:
 *   node scripts/production-audit.mjs               # audit production
 *   node scripts/production-audit.mjs --json        # machine-readable
 *   SITE=https://staging… node scripts/production-audit.mjs
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  formatReport, daysUntil, classifyDeadline, overallStatus,
  cspAllowsImageHost, extractOgContent,
} from "./lib/production-audit.mjs";

const SITE = process.env.AUDIT_SITE ?? "https://laxair.shop";
const API = process.env.AUDIT_API ?? "https://medinstru-api.onrender.com/graphql";
const BLOB = process.env.AUDIT_BLOB ?? "https://images.laxair.shop";
const EXPECTED_COMMIT = process.env.AUDIT_EXPECTED_COMMIT ?? "";

/** Deadlines worth counting down to. Dates only a human can know. */
const DEADLINES = [
  {
    name: "Render Postgres free tier expires",
    date: process.env.AUDIT_DB_EXPIRY ?? "2026-09-14",
    detail: "Free Postgres is DELETED, not paused. No backup strategy exists.",
    warnAt: 30,
    failAt: 14,
  },
];

const results = [];
const add = (area, name, status, detail) => results.push({ area, name, status, detail });

/**
 * Fetch with retries.
 *
 * Render's free tier spins down after ~15 minutes idle, so the first
 * request of the night can take ~50s or fail outright. Without this the
 * audit would report an outage every single night and be ignored within
 * a week.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const BUDGET_MS = 8 * 60_000;
const startedAt = Date.now();

/** Whether there is still time to make another request. */
function budgetExhausted() {
  return Date.now() - startedAt > BUDGET_MS;
}

/**
 * Fetch, with a HARD overall budget.
 *
 * The first version retried 3x60s with backoff, which is ~195s per
 * request. Across the dozen-plus sequential requests here that is ~39
 * minutes against a 15-minute job timeout -- so during a real outage,
 * the exact case this audit exists to report, the job would be killed
 * before formatReport() ever ran and NO report would be produced.
 *
 * Three bounds now, because one is not enough:
 *   - 15s per attempt, not 60
 *   - retries only while the site has not already been declared down
 *   - a global 8-minute budget after which every remaining request fails
 *     fast, leaving time to render and publish the report
 *
 * Reporting an outage matters more than confirming it three times.
 */
async function get(url, options = {}, attempts = 2) {
  if (budgetExhausted()) throw new Error("audit time budget exhausted");

  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, {
        redirect: "follow",
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      // Do not keep retrying a host already known to be down, and never
      // sleep past the budget.
      if (i < attempts - 1 && !siteIsDown && !budgetExhausted()) {
        await sleep(3000);
      } else {
        break;
      }
    }
  }
  throw lastError;
}

/**
 * Set once availability fails, so the remaining checks stop paying retry
 * cost against a host that is already known to be unreachable.
 */
let siteIsDown = false;

// ── Availability ────────────────────────────────────────────────────────
async function checkAvailability() {
  for (const [name, url] of [["Web", `${SITE}/en`], ["API", `${API}?query=%7B__typename%7D`]]) {
    try {
      const res = await get(url, { headers: { "apollo-require-preflight": "true" } });
      add("Availability", `${name} responds`, res.ok ? "pass" : "fail", `HTTP ${res.status}`);
    } catch (error) {
      if (name === "Web") siteIsDown = true;
      add("Availability", `${name} responds`, "fail", error.message);
    }
  }
}

// ── Deploy integrity ────────────────────────────────────────────────────
async function checkDeploy() {
  try {
    const res = await get(`${SITE}/en`);
    const live = res.headers.get("x-build-commit");
    const built = res.headers.get("x-build-time");
    if (!live) {
      add("Deploy", "Build identity header present", "fail", "x-build-commit missing");
      return null;
    }
    add("Deploy", "Build identity header present", "pass", `${live.slice(0, 8)} @ ${built ?? "?"}`);

    if (EXPECTED_COMMIT) {
      // Deploy skew is why this header exists: four rapid merges once left
      // Render serving stale commits with nothing exposing the mismatch.
      const match = live === EXPECTED_COMMIT;
      add("Deploy", "Live build matches main", match ? "pass" : "warn",
        match ? "in sync" : `live ${live.slice(0, 8)} vs main ${EXPECTED_COMMIT.slice(0, 8)}`);
    }
    return live;
  } catch (error) {
    add("Deploy", "Build identity header present", "fail", error.message);
    return null;
  }
}

// ── Link previews — regressed twice, silently, both times ───────────────
async function checkPreviews() {
  const pages = [["Home", `${SITE}/en`]];

  // A real product, discovered rather than hardcoded: seed ids are cuids
  // and change on every reseed.
  try {
    const q = "%7BproductsPaged%28page%3A1%2CpageSize%3A1%29%7Bitems%7Bid%20imageUrl%7D%7D%7D";
    const res = await get(`${API}?query=${q}`, { headers: { "apollo-require-preflight": "true" } });
    const json = await res.json();
    const item = json?.data?.productsPaged?.items?.[0];
    if (item) pages.push(["Product", `${SITE}/en/products/${item.id}`]);
    else add("Previews", "Found a product to check", "warn", "catalogue is empty");
  } catch (error) {
    add("Previews", "Found a product to check", "warn", error.message);
  }

  for (const [label, url] of pages) {
    try {
      // The real WhatsApp user-agent: this app's whole sharing feature is
      // judged by what that crawler receives.
      const res = await get(url, { headers: { "User-Agent": "WhatsApp/2.23.20.0 A" } });
      const html = await res.text();
      // Tolerates attribute order, single quotes and HTML entities -- a
      // regex for one exact serialization reported valid pages as broken
      // and fetched `&amp;` literally.
      const og = (p) => extractOgContent(html, p);

      const image = og("image");
      const title = og("title");

      add("Previews", `${label}: og:title`, title ? "pass" : "fail", title ?? "MISSING");

      if (!image) {
        // Exactly the live regression found on 2026-08-20: absolute blob
        // URLs stopped matching the managed-path rule and og:image was
        // dropped, so every shared product link previewed as bare text.
        add("Previews", `${label}: og:image present`, "fail", "MISSING — link previews as bare text");
        continue;
      }
      add("Previews", `${label}: og:image present`, "pass", image);

      // SVG is not a valid OpenGraph image. Facebook's scraper, which
      // WhatsApp uses, renders an empty frame for it.
      const isRaster = /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(image);
      add("Previews", `${label}: og:image is a raster`, isRaster ? "pass" : "fail",
        isRaster ? "" : "SVG — WhatsApp renders a blank frame");

      const abs = /^https?:\/\//.test(image);
      add("Previews", `${label}: og:image is absolute`, abs ? "pass" : "fail", abs ? "" : image);
      add("Previews", `${label}: og:image not localhost`,
        image.includes("localhost") ? "fail" : "pass", image.includes("localhost") ? image : "");

      if (abs) {
        const img = await get(image, { method: "HEAD" });
        add("Previews", `${label}: og:image fetchable`, img.ok ? "pass" : "fail",
          `HTTP ${img.status} ${img.headers.get("content-type") ?? ""}`);
      }
    } catch (error) {
      add("Previews", `${label}: preview card`, "fail", error.message);
    }
  }
}

// ── Security headers ────────────────────────────────────────────────────
async function checkSecurityHeaders() {
  try {
    const res = await get(`${SITE}/en`);
    const csp = res.headers.get("content-security-policy");
    const hsts = res.headers.get("strict-transport-security");

    add("Security", "CSP present", csp ? "pass" : "fail", csp ? "" : "MISSING");
    add("Security", "HSTS present", hsts ? "pass" : "fail", hsts ?? "MISSING");

    if (csp) {
      for (const d of ["frame-ancestors", "script-src", "img-src", "connect-src"]) {
        add("Security", `CSP has ${d}`, csp.includes(d) ? "pass" : "fail", "");
      }
      // If blob storage is configured, CSP MUST allow it or every product
      // image is blocked in the browser while looking fine to curl.
      // Parses the effective img-src (falling back to default-src, per the
      // CSP spec) instead of substring-matching the whole policy. The
      // substring check was wrong in BOTH directions: it passed when the
      // origin appeared only in connect-src while img-src blocked it, and
      // failed on `img-src https:` which genuinely permits the host.
      const host = new URL(BLOB).origin;
      const allowed = cspAllowsImageHost(csp, host);
      if (allowed === null) {
        add("Security", "CSP allows the blob host", "warn",
          `no img-src or default-src directive — ${host} is unrestricted`);
      } else {
        // A genuinely blocked image host is a production regression: every
        // product image fails in the browser while looking fine to curl.
        // Reporting that as a warning would let it exit 0 and CLOSE the
        // tracking issue.
        add("Security", "CSP allows the blob host", allowed ? "pass" : "fail",
          allowed ? host : `${host} BLOCKED by img-src — images fail in the browser`);
      }
    }
  } catch (error) {
    add("Security", "Security headers", "fail", error.message);
  }
}

// ── Caching / CDN ───────────────────────────────────────────────────────
async function checkCaching() {
  try {
    const html = await get(`${SITE}/en`);
    const body = await html.text();
    add("Caching", "HTML revalidates", /max-age=0/.test(html.headers.get("cache-control") ?? "") ? "pass" : "warn",
      html.headers.get("cache-control") ?? "none");

    const chunk = body.match(/\/_next\/static\/[^"]+\.js/)?.[0];
    if (chunk) {
      const js = await get(`${SITE}${chunk}`, { method: "HEAD" });
      const cc = js.headers.get("cache-control") ?? "";
      add("Caching", "Static JS immutable", cc.includes("immutable") ? "pass" : "fail", cc || "none");
      // Informational: the app is not behind our CDN today. Reported so
      // the day it changes is visible, never failed on.
      add("Caching", "Static JS edge-cached", js.headers.get("cf-cache-status") === "HIT" ? "pass" : "warn",
        `cf-cache-status: ${js.headers.get("cf-cache-status") ?? "none"} (app is not proxied — expected)`);
    }

    const img = await get(`${BLOB}/products/lab-equipment.png`, { method: "HEAD" });
    const icc = img.headers.get("cache-control") ?? "";
    add("Caching", "Blob images immutable", icc.includes("immutable") ? "pass" : "fail", icc || "none");
    add("Caching", "Blob images edge-cached", img.headers.get("cf-cache-status") === "HIT" ? "pass" : "warn",
      `cf-cache-status: ${img.headers.get("cf-cache-status") ?? "none"}`);
  } catch (error) {
    add("Caching", "Cache headers", "fail", error.message);
  }
}

// ── Blob storage integrity ──────────────────────────────────────────────
async function checkBlobIntegrity() {
  try {
    const q = "%7BproductsPaged%28page%3A1%2CpageSize%3A50%29%7Bitems%7BimageUrl%7D%7D%7D";
    const res = await get(`${API}?query=${q}`, { headers: { "apollo-require-preflight": "true" } });
    const items = (await res.json())?.data?.productsPaged?.items ?? [];
    const urls = [...new Set(items.map((i) => i.imageUrl).filter(Boolean))];

    if (!urls.length) {
      add("Storage", "Product images resolve", "warn", "no product images to check");
      return;
    }

    let broken = 0;
    for (const url of urls) {
      const abs = url.startsWith("http") ? url : `${SITE}${url}`;
      const head = await get(abs, { method: "HEAD" });
      if (!head.ok) broken++;
      // Every SVG must have its PNG twin, or link previews 404 silently.
      if (/\.svg$/i.test(abs)) {
        const twin = await get(abs.replace(/\.svg$/i, ".png"), { method: "HEAD" });
        if (!twin.ok) broken++;
      }
    }
    add("Storage", "Product images and PNG twins resolve", broken ? "fail" : "pass",
      broken ? `${broken} broken of ${urls.length} images` : `${urls.length} images OK`);
  } catch (error) {
    add("Storage", "Product images resolve", "fail", error.message);
  }
}

// ── Correlation / CORS ──────────────────────────────────────────────────
async function checkCorrelation() {
  try {
    const res = await get(`${API}?query=%7B__typename%7D`, { headers: { "apollo-require-preflight": "true" } });
    add("Correlation", "Server issues x-request-id", res.headers.get("x-request-id") ? "pass" : "fail",
      res.headers.get("x-request-id") ?? "MISSING");
    add("Correlation", "x-request-id exposed to JS",
      (res.headers.get("access-control-expose-headers") ?? "").includes("x-request-id") ? "pass" : "fail", "");

    const pre = await fetch(API, {
      method: "OPTIONS",
      headers: {
        Origin: SITE,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,x-session-id",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const allow = pre.headers.get("access-control-allow-headers") ?? "";
    // Omitting max-age means a preflight before EVERY request -- a full
    // extra round trip each time, on connections this app targets.
    add("Correlation", "Preflight is cached", pre.headers.get("access-control-max-age") ? "pass" : "warn",
      `max-age: ${pre.headers.get("access-control-max-age") ?? "none"}`);
    add("Correlation", "Authorization allowed by CORS", allow.includes("authorization") ? "pass" : "fail",
      allow.includes("authorization") ? "" : "authenticated requests would fail preflight");
  } catch (error) {
    add("Correlation", "Correlation headers", "fail", error.message);
  }
}

// ── Certificates ────────────────────────────────────────────────────────
async function checkCertificates() {
  for (const host of [new URL(SITE).hostname, new URL(BLOB).hostname]) {
    try {
      // No TLS introspection from fetch(); crt.sh is a public CT log.
      const res = await fetch(`https://crt.sh/?q=${host}&output=json&exclude=expired`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`crt.sh HTTP ${res.status}`);
      const entries = await res.json();
      const latest = entries.map((e) => e.not_after).sort().at(-1);
      if (!latest) {
        add("Certificates", `${host} certificate`, "warn", "no unexpired entry found in CT logs");
        continue;
      }
      const days = daysUntil(latest);
      add("Certificates", `${host} certificate`, classifyDeadline(days, { warnAt: 14, failAt: 3 }),
        `${days} days remaining`);
    } catch (error) {
      // Never fail the audit because a third-party lookup was down.
      add("Certificates", `${host} certificate`, "skip", error.message);
    }
  }
}

// ── Deadlines ───────────────────────────────────────────────────────────
function checkDeadlines() {
  for (const d of DEADLINES) {
    const days = daysUntil(d.date);
    add("Deadlines", d.name, classifyDeadline(days, d),
      `${days} days (${d.date}) — ${d.detail}`);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────
const commit = await (async () => {
  await checkAvailability();
  const c = await checkDeploy();
  await checkPreviews();
  await checkSecurityHeaders();
  await checkCaching();
  await checkBlobIntegrity();
  await checkCorrelation();
  await checkCertificates();
  checkDeadlines();
  return c;
})();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ status: overallStatus(results), results }, null, 2));
} else {
  console.log(formatReport(results, { commit, when: new Date().toISOString() }));
}

// Only a real failure exits non-zero. Warnings are reported, never paged.
process.exit(overallStatus(results) === "fail" ? 1 : 0);
