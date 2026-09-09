#!/usr/bin/env bash
set -euo pipefail

# Decides whether dependency-freshness.yml's check should pass or fail,
# given pnpm outdated's own JSON output and this repo's allowlist of
# known-blocked packages (scripts/known-outdated-packages.txt). Split out
# from the workflow so the decision logic is testable
# (check-outdated.test.sh) instead of living only in inline bash.
#
# Fails (exit 1) only for a MAJOR-version gap that is not on the
# allowlist. A same-major gap is reported and does not fail.
#
# Why the major/minor split, rather than failing on any staleness: this
# check went red on essentially every publish, which is not the same thing
# as a repo that is behind. Measured directly on 2026-09-08 — a CI run
# flagged @anthropic-ai/sdk, @playwright/test and lint-staged; bumping all
# three and re-running an hour later flagged @types/node, lucide-react and
# typescript-eslint instead. Six packages, one morning, none of them a real
# problem. A check that is red by default stops being read, which is the
# state this repo has already documented once for perf-budget's LCP.
#
# Minor and patch gaps are already handled: Dependabot opens a grouped
# minor-and-patch PR every Monday, so a red badge adds no information the
# PR queue does not already carry. Majors are ungrouped, filed
# individually, and are the ones that need a decision — so those still
# fail.
#
# They are still PRINTED either way. The table always shows every outdated
# package, so "does not fail" never means "not shown."
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

# The leading numeric component, with any range prefix and build/prerelease
# tail removed. "8.0.0-rc.13" -> 8, "^1.62.1" -> 1. A value with no leading
# digit yields the empty string, which the caller treats as unknown.
#
# A 0.x minor therefore reads as SAME-major, and that is a judgment call
# rather than an oversight. By strict semver 0.x's minor slot is where
# breaking changes go — but Dependabot groups 0.x minors into the same
# weekly minor-and-patch PR regardless, so failing here would add a red
# without changing how the bump is actually reviewed. Pinned by a test so
# the decision is visible if anyone disagrees with it later.
major_of() {
  printf '%s' "$1" | sed -E 's/^[^0-9]*//; s/[.-].*$//'
}

unaccounted=()
same_major=()
while IFS= read -r pkg; do
  found=false
  for a in "${allowed[@]}"; do
    if [ "$pkg" = "$a" ]; then
      found=true
      break
    fi
  done
  [ "$found" = true ] && continue

  cur_major=$(major_of "$(jq -r --arg p "$pkg" '.[$p].current' "$OUTDATED_JSON")")
  new_major=$(major_of "$(jq -r --arg p "$pkg" '.[$p].latest' "$OUTDATED_JSON")")

  # An unparseable version on either side is treated as a major gap rather
  # than waved through. Failing OPEN here is deliberate: the cost of a
  # needless red is one look, and the cost of silently skipping a real
  # major is that this check stops covering the only case it still fails on.
  if [ -n "$cur_major" ] && [ -n "$new_major" ] && [ "$cur_major" = "$new_major" ]; then
    same_major+=("$pkg")
  else
    unaccounted+=("$pkg")
  fi
done < <(jq -r 'keys[]' "$OUTDATED_JSON")

if [ "${#same_major[@]}" -gt 0 ]; then
  echo "Same-major updates (Dependabot's weekly grouped PR covers these — not failing):"
  printf '  %s\n' "${same_major[@]}"
  echo
fi

if [ "${#unaccounted[@]}" -eq 0 ]; then
  echo "No unaccounted MAJOR updates — nothing actionable right now."
  exit 0
fi

echo "MAJOR updates NOT on the allowlist (actionable):"
printf '  %s\n' "${unaccounted[@]}"
exit 1
