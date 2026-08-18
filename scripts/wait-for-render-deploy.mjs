#!/usr/bin/env node
// Thin CLI wrapper around scripts/lib/render-deploy-status.mjs's pure
// classification logic -- see that file for the full #78 §1.4 reasoning
// (the purge must fire after Render confirms the deploy is actually
// live, not after CI finishes, which races Render's own asynchronous
// deploy).
//
// Not wired into any workflow yet -- there's no CDN/purge step to
// sequence this in front of until #78 Part 1's own blocking prerequisite
// (a custom domain) is resolved. Usage, once there is one:
//   RENDER_API_KEY=... node scripts/wait-for-render-deploy.mjs <service-id> <commit-sha>
//
// Verification status, honestly: the classification logic itself
// (render-deploy-status.test.mjs) and this wrapper's own request/
// pagination/polling logic (wait-for-render-deploy.test.mjs, against a
// stubbed fetch) are real, committed, node --test-covered code. The
// *live* Render API call has NOT been exercised against a real API key
// in this session -- none was available. Treat the actual network
// request/response shape as unverified against the real endpoint until
// it's run once with real credentials, even though the pagination logic
// itself is tested against the documented mechanics (confirmed via
// api-docs.render.com: cursor-based, `?cursor=<last item's cursor>` to
// get the next page -- the exact end-of-results signal isn't documented,
// so this stops on the standard, safe convention of "a page returned
// fewer items than the requested limit", with a hard page-count cap as a
// backstop regardless of whether that convention holds).

import {
  findDeployForCommit,
  classifyDeployReadiness,
  shouldStopPolling,
  shouldPurge,
} from "./lib/render-deploy-status.mjs";

const RENDER_API_BASE = "https://api.render.com/v1";
const PAGE_LIMIT = 20;
// A real AI review caught that the original version only ever fetched one
// page, silently reporting "not_found" forever for any commit outside the
// most recent 20 deploys even though it may have a real, terminal deploy
// further back. Bounded at 5 pages (100 deploys) rather than unbounded --
// a target commit's own deploy realistically should be near the front
// (this is meant to run right after that commit's own CI passes), so
// needing more than 100 deploys back to find it means something is
// already wrong; better to fail with "not found after a bounded search"
// than to paginate indefinitely against a typo'd commit SHA.
const MAX_PAGES = 5;

// A second AI review round caught that MAX_ATTEMPTS's own "10 minutes --
// a hard bound" comment was false: no individual request had a timeout,
// so one stalled Render API call could block the whole loop indefinitely,
// regardless of how few attempts were configured. Meaningfully shorter
// than POLL_INTERVAL_MS below, so a timed-out request doesn't itself eat
// into the next poll's own gap.
const REQUEST_TIMEOUT_MS = 30_000;

// Wraps one fetchImpl call with a real, enforced timeout via
// AbortController -- fetchImpl is still injectable (tests pass a stub
// that reacts to the abort signal the same way real fetch() does), and
// requestTimeoutMs is its own parameter so tests can use a short timeout
// instead of waiting 30 real seconds to prove the abort actually fires.
async function fetchWithTimeout(fetchImpl, url, options, requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchDeploys(
  serviceId,
  apiKey,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
) {
  const deploys = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${RENDER_API_BASE}/services/${serviceId}/deploys`);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetchWithTimeout(
      fetchImpl,
      url.toString(),
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
      requestTimeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Render API returned ${res.status}: ${await res.text()}`);
    }
    // Each item is {deploy, cursor} -- the cursor for fetching the page
    // that starts after *this specific* item, not one shared cursor for
    // the whole response (confirmed via api-docs.render.com).
    const items = await res.json();
    deploys.push(...items.map((item) => item.deploy));

    if (items.length < PAGE_LIMIT) break; // fewer than requested = last page
    cursor = items[items.length - 1].cursor;
  }
  return deploys;
}

const POLL_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 60; // 10 minutes -- a hard bound distinct from Render's own build time, same reasoning ci.yml's comment-ci-result-on-pr job already uses for its own poll loop (never silently run forever on a genuine stuck deploy).

// sleepImpl/pollIntervalMs/maxAttempts/requestTimeoutMs are all injectable
// so tests can run the full poll loop instantly instead of waiting on
// real timers.
export async function waitForDeploy(
  serviceId,
  targetCommitSha,
  apiKey,
  {
    fetchImpl = fetch,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs = POLL_INTERVAL_MS,
    maxAttempts = MAX_ATTEMPTS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    onAttempt = () => {},
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deploys = await fetchDeploys(serviceId, apiKey, fetchImpl, requestTimeoutMs);
    const deploy = findDeployForCommit(deploys, targetCommitSha);
    const readiness = classifyDeployReadiness(deploy);
    onAttempt({ attempt, readiness, deploy });

    if (shouldStopPolling(readiness)) {
      return { readiness, shouldPurge: shouldPurge(readiness) };
    }
    if (attempt < maxAttempts) await sleepImpl(pollIntervalMs);
  }
  return { readiness: "timed_out", shouldPurge: false };
}

async function main() {
  const [serviceId, targetCommitSha] = process.argv.slice(2);
  const apiKey = process.env.RENDER_API_KEY;

  if (!serviceId || !targetCommitSha) {
    console.error(
      "Usage: RENDER_API_KEY=... node scripts/wait-for-render-deploy.mjs <service-id> <commit-sha>",
    );
    process.exit(2);
  }
  if (!apiKey) {
    console.error("RENDER_API_KEY is not set.");
    process.exit(2);
  }

  const result = await waitForDeploy(serviceId, targetCommitSha, apiKey, {
    onAttempt: ({ attempt, readiness, deploy }) => {
      console.log(`attempt ${attempt}: ${readiness}${deploy ? ` (status=${deploy.status})` : ""}`);
    },
  });

  if (result.shouldPurge) {
    console.log(`Commit ${targetCommitSha} is live. Safe to purge.`);
    process.exit(0);
  }
  console.error(`Commit ${targetCommitSha} will not go live (${result.readiness}). Not purging.`);
  process.exit(1);
}

// Only run main() when executed directly, not when imported by the test
// file for fetchDeploys/waitForDeploy's own coverage.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("wait-for-render-deploy.mjs crashed:", error);
    process.exit(1);
  });
}
