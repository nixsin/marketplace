#!/usr/bin/env bash
set -euo pipefail

# Publishes a shields.io "endpoint" badge JSON file to the gh-pages branch,
# under coverage/<name>-badge.json, so shields.io can render it live via
# raw.githubusercontent.com — no third-party badge service/account needed.
# Bootstraps the gh-pages branch as an orphan branch on first run if it
# doesn't exist yet. Retries on push conflict (another job racing to update
# a different file on the same branch) with a jittered backoff.
#
# Usage: scripts/publish-badge.sh <name> <path-to-json-file>
# Requires GITHUB_TOKEN and GITHUB_REPOSITORY in the environment (both set
# automatically inside GitHub Actions).

NAME="$1"
JSON_FILE="$2"
REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

for attempt in 1 2 3 4 5; do
  rm -rf "$WORKDIR"
  if git clone --branch gh-pages --single-branch --depth 1 "$REPO_URL" "$WORKDIR" 2>/dev/null; then
    :
  else
    git clone --depth 1 "$REPO_URL" "$WORKDIR"
    (cd "$WORKDIR" && git checkout --orphan gh-pages && git rm -rf . >/dev/null 2>&1 || true)
  fi

  mkdir -p "$WORKDIR/coverage"
  cp "$JSON_FILE" "$WORKDIR/coverage/${NAME}-badge.json"

  if (
    cd "$WORKDIR"
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add "coverage/${NAME}-badge.json"
    if git diff --cached --quiet; then
      echo "No change to ${NAME} badge, skipping."
      exit 0
    fi
    git commit -m "Update ${NAME} coverage badge" --quiet
    git push origin HEAD:gh-pages
  ); then
    exit 0
  fi

  echo "Push attempt ${attempt} failed, retrying..."
  sleep $((RANDOM % 5 + 1))
done

echo "Failed to publish ${NAME} badge after retries"
exit 1
