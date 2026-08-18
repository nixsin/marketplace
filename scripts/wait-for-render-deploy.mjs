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
// (render-deploy-status.test.mjs) is real, committed, node --test-covered
// code, exercised against Render's actual documented deploy-status enum
// (confirmed via api-docs.render.com, not guessed). The live API call
// below has NOT been exercised against a real Render API key in this
// session -- no RENDER_API_KEY was available. Treat fetchDeploys as
// unverified against the real endpoint until it's actually run once with
// real credentials.

import {
  findDeployForCommit,
  classifyDeployReadiness,
  shouldStopPolling,
  shouldPurge,
} from "./lib/render-deploy-status.mjs";

const RENDER_API_BASE = "https://api.render.com/v1";
const POLL_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 60; // 10 minutes -- a hard bound distinct from Render's own build time, same reasoning ci.yml's comment-ci-result-on-pr job already uses for its own poll loop (never silently run forever on a genuine stuck deploy).

async function fetchDeploys(serviceId, apiKey) {
  const res = await fetch(`${RENDER_API_BASE}/services/${serviceId}/deploys?limit=20`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Render API returned ${res.status}: ${await res.text()}`);
  }
  const pages = await res.json();
  // The list endpoint wraps each item as {deploy, cursor} for pagination
  // -- unwrap to the plain deploy objects the pure logic operates on.
  return pages.map((page) => page.deploy);
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const deploys = await fetchDeploys(serviceId, apiKey);
    const deploy = findDeployForCommit(deploys, targetCommitSha);
    const readiness = classifyDeployReadiness(deploy);
    console.log(`attempt ${attempt}: ${readiness}${deploy ? ` (status=${deploy.status})` : ""}`);

    if (shouldStopPolling(readiness)) {
      if (shouldPurge(readiness)) {
        console.log(`Commit ${targetCommitSha} is live. Safe to purge.`);
        process.exit(0);
      }
      console.error(`Commit ${targetCommitSha} will not go live (${readiness}). Not purging.`);
      process.exit(1);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.error(`Timed out after ${MAX_ATTEMPTS} attempts waiting for ${targetCommitSha} to deploy.`);
  process.exit(1);
}

main().catch((error) => {
  console.error("wait-for-render-deploy.mjs crashed:", error);
  process.exit(1);
});
