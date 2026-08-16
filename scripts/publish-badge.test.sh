#!/usr/bin/env bash
set -euo pipefail

# Exercises publish-badge.sh's history-append behavior against a local bare
# git repo standing in for gh-pages (via PUBLISH_BADGE_REPO_URL), so this
# logic has automated coverage instead of relying on by-hand verification.
# Covers: first publish creates badge + a one-entry history + dashboard;
# a second publish with an unchanged pct still appends a new entry (the
# whole point of appending unconditionally — a flat line, not a gap); and
# that a badge-only call (no pct) never creates a history file at all.
#
# Run from the repo root: bash scripts/publish-badge.test.sh

fail() { echo "FAIL: $1" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

BARE="$TMPDIR/origin.git"
git init --bare -q "$BARE"

export GITHUB_TOKEN="unused"
export GITHUB_REPOSITORY="unused/unused"
export PUBLISH_BADGE_REPO_URL="$BARE"

echo '{"schemaVersion":1,"label":"api coverage","message":"90%","color":"brightgreen"}' > "$TMPDIR/badge.json"

check_out() {
  rm -rf "$TMPDIR/check"
  git clone --branch gh-pages --single-branch -q "$BARE" "$TMPDIR/check"
}

# --- First publish: bootstraps gh-pages, writes badge + fresh history. ---
./scripts/publish-badge.sh api "$TMPDIR/badge.json" 90 commit1
check_out
[ -f "$TMPDIR/check/coverage/api-badge.json" ] || fail "badge missing after first publish"
[ -f "$TMPDIR/check/coverage/index.html" ] || fail "dashboard missing after first publish (scripts/coverage-dashboard/index.html should have been synced)"
count=$(jq 'length' "$TMPDIR/check/coverage/api-history.json")
[ "$count" = "1" ] || fail "expected 1 history entry after first publish, got $count"
entry=$(jq -c '.[0]' "$TMPDIR/check/coverage/api-history.json")
echo "$entry" | jq -e '.pct == 90 and .commit == "commit1" and (.date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))' > /dev/null \
  || fail "first history entry has unexpected shape: $entry"

# --- Second publish, same pct: must still append (flat line, not a gap). ---
./scripts/publish-badge.sh api "$TMPDIR/badge.json" 90 commit2
check_out
count=$(jq 'length' "$TMPDIR/check/coverage/api-history.json")
[ "$count" = "2" ] || fail "expected 2 history entries after unchanged-value publish, got $count"
last_commit=$(jq -r '.[-1].commit' "$TMPDIR/check/coverage/api-history.json")
[ "$last_commit" = "commit2" ] || fail "expected latest history entry to be commit2, got $last_commit"

# --- Badge-only call (no pct): must not create a web-history.json at all. ---
echo '{"schemaVersion":1,"label":"web coverage","message":"99%","color":"brightgreen"}' > "$TMPDIR/web-badge.json"
./scripts/publish-badge.sh web "$TMPDIR/web-badge.json"
check_out
[ -f "$TMPDIR/check/coverage/web-badge.json" ] || fail "web badge missing after badge-only publish"
[ -f "$TMPDIR/check/coverage/web-history.json" ] && fail "web-history.json should not exist when pct is omitted"

echo "OK: publish-badge.sh history-append behavior verified"
