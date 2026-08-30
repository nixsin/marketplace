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

# --- A non-allowlisted package outdated: must fail. ---
cat > "$TMPDIR/unaccounted.json" <<'EOF'
{
  "eslint": {"current": "9.39.5", "latest": "10.8.1"},
  "shadcn": {"current": "4.17.0", "latest": "4.18.0"}
}
EOF
if ./scripts/check-outdated.sh "$TMPDIR/unaccounted.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "expected failure when a non-allowlisted package is outdated"
fi
grep -q "shadcn" "$TMPDIR/out.txt" || fail "expected the unaccounted package to be named in the output"
actionable_section=$(sed -n '/NOT on the allowlist/,$p' "$TMPDIR/out.txt")
echo "$actionable_section" | grep -q "eslint" && fail "allowlisted package should not appear in the actionable section"
echo "$actionable_section" | grep -q "shadcn" || fail "unaccounted package must appear in the actionable section"

# --- Only non-allowlisted packages outdated: must fail. ---
cat > "$TMPDIR/all-unaccounted.json" <<'EOF'
{
  "libphonenumber-js": {"current": "1.13.10", "latest": "1.13.11"}
}
EOF
if ./scripts/check-outdated.sh "$TMPDIR/all-unaccounted.json" "$TMPDIR/allowlist.txt" > "$TMPDIR/out.txt" 2>&1; then
  fail "expected failure when no outdated packages are allowlisted"
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
