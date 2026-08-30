#!/usr/bin/env bash
set -euo pipefail

# Decides whether dependency-freshness.yml's check should pass or fail,
# given pnpm outdated's own JSON output and this repo's allowlist of
# known-blocked packages (scripts/known-outdated-packages.txt). Split out
# from the workflow so the decision logic is testable
# (check-outdated.test.sh) instead of living only in inline bash.
#
# Passes (exit 0) when every outdated package is on the allowlist, or
# there are no outdated packages at all. Fails (exit 1) when any outdated
# package isn't accounted for — that's real, actionable staleness, not
# noise. Always prints the full outdated table either way, so "not
# failing" never means "not shown."
#
# Usage: scripts/check-outdated.sh <outdated-json-file> <allowlist-file>

OUTDATED_JSON="$1"
ALLOWLIST="$2"

package_count=$(jq 'keys | length' "$OUTDATED_JSON")

if [ "$package_count" -eq 0 ]; then
  echo "No outdated packages."
  exit 0
fi

echo "Outdated packages:"
jq -r 'to_entries[] | "  \(.key): \(.value.current) -> \(.value.latest)"' "$OUTDATED_JSON"
echo

# Strip comments and blank lines from the allowlist. Built with a plain
# read loop (not `mapfile`/`readarray`) since those aren't available in
# macOS's stock bash 3.2 — this needs to run identically there and on
# CI's bash 5.
# An entry may carry its reason inline (`prisma  # latest is an RC`), so
# the justification travels with the package rather than living only in
# CLAUDE.md, where an entry and its rationale drift apart silently. The
# inline part is stripped here; without that, the whole-line comparison
# below would never match and the entry would be silently inert -- which
# fails OPEN (the check goes red), so it is loud rather than dangerous,
# but it is still a trap worth removing.
allowed=()
while IFS= read -r a; do
  a="${a%%#*}"                       # drop an inline reason
  a="${a#"${a%%[![:space:]]*}"}"     # trim leading space
  a="${a%"${a##*[![:space:]]}"}"     # trim trailing space
  [ -n "$a" ] && allowed+=("$a")
done < <(grep -v '^[[:space:]]*#' "$ALLOWLIST" | grep -v '^[[:space:]]*$')

unaccounted=()
while IFS= read -r pkg; do
  found=false
  for a in "${allowed[@]}"; do
    if [ "$pkg" = "$a" ]; then
      found=true
      break
    fi
  done
  if [ "$found" = false ]; then
    unaccounted+=("$pkg")
  fi
done < <(jq -r 'keys[]' "$OUTDATED_JSON")

if [ "${#unaccounted[@]}" -eq 0 ]; then
  echo "All outdated packages are on the known-blocked allowlist ($ALLOWLIST) — nothing actionable right now."
  exit 0
fi

echo "Outdated packages NOT on the allowlist (actionable):"
printf '  %s\n' "${unaccounted[@]}"
exit 1
