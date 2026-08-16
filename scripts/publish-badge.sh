#!/usr/bin/env bash
set -euo pipefail

# Publishes a shields.io "endpoint" badge JSON file to the gh-pages branch,
# under coverage/<name>-badge.json, so shields.io can render it live via
# raw.githubusercontent.com — no third-party badge service/account needed.
# Bootstraps the gh-pages branch as an orphan branch on first run if it
# doesn't exist yet. Retries on push conflict (another job racing to update
# a different file on the same branch) with a jittered backoff.
#
# Optionally also appends a {date, commit, pct} entry to
# coverage/<name>-history.json in the same commit, when PCT is passed —
# the running time series the coverage-history dashboard (coverage/
# index.html on this same branch) reads. Skipped entirely if PCT is
# omitted, so this script's original badge-only behavior is unaffected
# for any caller that doesn't pass it.
#
# Also syncs scripts/coverage-dashboard/index.html (the dashboard page
# itself, version-controlled on main) to coverage/index.html on gh-pages
# every run, if that source file exists in the checkout — cheap (git
# only actually commits it when its content changes, via the same
# diff-check below) and means every coverage-publishing run keeps the
# published dashboard in sync with main without needing separate wiring.
#
# Usage: scripts/publish-badge.sh <name> <path-to-json-file> [pct] [commit-sha]
# Requires GITHUB_TOKEN and GITHUB_REPOSITORY in the environment (both set
# automatically inside GitHub Actions).
#
# PUBLISH_BADGE_REPO_URL overrides the target remote (default: this repo on
# GitHub, over HTTPS with GITHUB_TOKEN). Exists solely so
# publish-badge.test.sh can point this script at a local bare repo instead
# of a real GitHub remote — no caller inside ci.yml sets it, so production
# behavior is unchanged.

NAME="$1"
JSON_FILE="$2"
PCT="${3:-}"
COMMIT_SHA="${4:-}"
REPO_URL="${PUBLISH_BADGE_REPO_URL:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
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

  if [ -f "scripts/coverage-dashboard/index.html" ]; then
    cp "scripts/coverage-dashboard/index.html" "$WORKDIR/coverage/index.html"
  fi

  # Appends unconditionally (not just when the badge value differs) — a
  # coverage-over-time chart needs a data point every time a measurement
  # happened, even an unchanged one, or unchanged stretches show as gaps
  # instead of a flat line. Re-cloning gh-pages fresh on every retry
  # attempt (see the top of the loop) means this reads the current
  # remote history each time, so a retry after a genuine push conflict
  # appends exactly once — it never compounds into duplicate entries.
  if [ -n "$PCT" ]; then
    history_file="$WORKDIR/coverage/${NAME}-history.json"
    [ -f "$history_file" ] || echo "[]" > "$history_file"
    date_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    jq --arg date "$date_iso" --arg commit "$COMMIT_SHA" --argjson pct "$PCT" \
      '. + [{date: $date, commit: $commit, pct: $pct}]' "$history_file" > "$history_file.tmp"
    mv "$history_file.tmp" "$history_file"
  fi

  if (
    cd "$WORKDIR"
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add "coverage/${NAME}-badge.json"
    if [ -n "$PCT" ]; then
      git add "coverage/${NAME}-history.json"
    fi
    if [ -f "coverage/index.html" ]; then
      git add "coverage/index.html"
    fi
    if git diff --cached --quiet; then
      echo "No change to ${NAME} badge, history, or dashboard, skipping."
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
