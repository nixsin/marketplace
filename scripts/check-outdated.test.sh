#!/usr/bin/env bash
set -euo pipefail

# Exercises check-outdated.sh's pass/fail decision against fixture data,
# so a regression here (e.g. the allowlist comparison silently matching
# everything, or nothing) fails CI instead of only being noticed the next
# time dependency-freshness.yml runs for real.
#
# Run from the repo root: bash scripts/check-outdated.test.sh

fail() { echo "FAIL: $1" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/allowlist.txt" <<'EOF'
# comment line, should be ignored

eslint
@eslint/js  # inline reason: must be stripped, not treated as part of the name
   typescript
EOF

# --- No outdated packages at all: must pass. ---
echo '{}' > "$TMPDIR/empty.json"
if ! ./scripts/check-outdated.sh "$TMPDIR/empty.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt"; then
  fail "expected pass on empty outdated list"
fi
grep -q "No outdated packages" "$TMPDIR/out.txt" || fail "expected 'No outdated packages' message"

# --- Only allowlisted packages outdated: must pass. ---
cat > "$TMPDIR/allowlisted-only.json" <<'EOF'
{
  "eslint": {"current": "9.39.5", "latest": "10.8.1"},
  "typescript": {"current": "5.9.3", "latest": "7.0.2"}
}
EOF
if ! ./scripts/check-outdated.sh "$TMPDIR/allowlisted-only.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt"; then
  fail "expected pass when every outdated package is allowlisted"
fi
grep -q "nothing actionable right now" "$TMPDIR/out.txt" || fail "expected the allowlist-pass message"

# --- A non-allowlisted MAJOR gap: must fail. ---
cat > "$TMPDIR/unaccounted.json" <<'EOF'
{
  "eslint": {"current": "9.39.5", "latest": "10.8.1"},
  "shadcn": {"current": "4.17.0", "latest": "5.0.0"}
}
EOF
if ./scripts/check-outdated.sh "$TMPDIR/unaccounted.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "expected failure when a non-allowlisted MAJOR update exists"
fi
grep -q "shadcn" "$TMPDIR/out.txt" || fail "expected the unaccounted package to be named in the output"
actionable_section=$(sed -n '/NOT on the allowlist/,$p' "$TMPDIR/out.txt")
echo "$actionable_section" | grep -q "eslint" && fail "allowlisted package should not appear in the actionable section"
echo "$actionable_section" | grep -q "shadcn" || fail "unaccounted package must appear in the actionable section"

# --- Non-allowlisted SAME-MAJOR gaps: must pass, and must still be shown. ---
#
# The rule this file exists to pin. Dependabot's weekly grouped PR already
# carries every minor and patch, so failing here reports nothing the PR
# queue does not, while making the check red on essentially every publish.
# Measured on 2026-09-08: a CI run flagged three packages, and bumping all
# three flagged three DIFFERENT ones an hour later.
cat > "$TMPDIR/same-major.json" <<'EOF'
{
  "shadcn": {"current": "4.17.0", "latest": "4.18.0"},
  "libphonenumber-js": {"current": "1.13.10", "latest": "1.13.11"}
}
EOF
if ! ./scripts/check-outdated.sh "$TMPDIR/same-major.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "a same-major gap must not fail the check"
fi
# Not failing must never mean not shown.
grep -q "shadcn" "$TMPDIR/out.txt" || fail "same-major packages must still be listed"
grep -q "libphonenumber-js" "$TMPDIR/out.txt" || fail "same-major packages must still be listed"

# --- A 0.x minor is treated as same-major, deliberately. ---
#
# By strict semver a 0.x minor is the breaking-change slot, so this is a
# judgment call rather than an oversight: Dependabot groups 0.x minors into
# the same weekly minor-and-patch PR, so failing here would add noise
# without changing how the bump is actually handled.
cat > "$TMPDIR/zerover.json" <<'EOF'
{"@anthropic-ai/sdk": {"current": "0.123.0", "latest": "0.124.0"}}
EOF
if ! ./scripts/check-outdated.sh "$TMPDIR/zerover.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "a 0.x minor should be treated as same-major"
fi

# --- A prerelease MAJOR still counts as a major gap. ---
#
# prisma's `latest` is an RC a whole major ahead; the tail must not confuse
# the comparison into reading it as same-major.
cat > "$TMPDIR/prerelease.json" <<'EOF'
{"someprisma": {"current": "7.10.0", "latest": "8.0.0-rc.13"}}
EOF
if ./scripts/check-outdated.sh "$TMPDIR/prerelease.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "a prerelease one major ahead must still fail"
fi

# --- An unparseable version fails OPEN (treated as a major gap). ---
#
# The cost of a needless red is one look; the cost of waving it through is
# that the check stops covering the only case it still fails on.
cat > "$TMPDIR/unparseable.json" <<'EOF'
{"weird": {"current": "not-a-version", "latest": "also-not"}}
EOF
if ./scripts/check-outdated.sh "$TMPDIR/unparseable.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "an unparseable version must fail open, not be skipped"
fi

# --- Malformed versions with MATCHING embedded digits must still fail. ---
#
# The case the no-digits fixture above does not reach, and the one an
# earlier major_of() got wrong: it stripped any leading text and kept the
# first number it found, so "build1.alpha" and "release1-beta" both reduced
# to 1, compared EQUAL, and took the same-major path -- silently waving
# through exactly the input the fail-open rule exists for.
cat > "$TMPDIR/embedded-digits.json" <<'EOF'
{"weird2": {"current": "build1.alpha", "latest": "release1-beta"}}
EOF
if ./scripts/check-outdated.sh "$TMPDIR/embedded-digits.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "malformed versions sharing an embedded digit must not read as same-major"
fi

# --- A well-formed version with a range prefix still parses. ---
#
# The other direction: hardening the parser must not start rejecting real
# input. A caret-prefixed same-major pair must still pass.
cat > "$TMPDIR/prefixed.json" <<'EOF'
{"ranged": {"current": "^1.62.1", "latest": "^1.63.0"}}
EOF
if ! ./scripts/check-outdated.sh "$TMPDIR/prefixed.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "a range-prefixed same-major pair must still be recognised as same-major"
fi


# --- An entry carrying an inline reason must still match. ---
#
# The reason is the whole point of allowing it: a bare package name cannot
# be reviewed without cross-referencing CLAUDE.md, and the two drift. If
# the parser ever stops stripping it, the entry silently stops matching and
# the package reads as actionable again -- so assert the match directly.
# `typescript` is indented in the fixture above for the same reason.
cat > "$TMPDIR/inline.json" <<'EOF'
{"@eslint/js": {"current": "9.39.5", "latest": "10.0.1"},
 "typescript": {"current": "5.9.3", "latest": "7.0.2"}}
EOF
if ! ./scripts/check-outdated.sh "$TMPDIR/inline.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt"; then
  fail "an allowlist entry with an inline reason (or leading space) should still match"
fi

echo "OK: check-outdated.sh pass/fail decisions verified"
