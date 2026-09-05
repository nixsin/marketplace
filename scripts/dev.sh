#!/usr/bin/env bash
# One-command local setup: Postgres + Redis + API + web, migrated and
# seeded, running with hot-reload. Safe to re-run — migrations are
# idempotent (`migrate deploy`) and a failed/duplicate seed doesn't stop
# the script (see the `|| echo` below).
set -euo pipefail
cd "$(dirname "$0")/.."

# Preflight: the tools this stack needs, at the versions this repo declares.
#
# Replaces a bare `command -v docker` check with the full set -- node, pnpm,
# docker, terraform, gh, psql -- and their versions, read from where the repo
# already declares them. It also reports tools that resolve in THIS shell but
# would not in a new terminal, which is the failure that motivated it.
#
# --tools-only deliberately: the dev stack needs docker and pnpm and does not
# need a WhatsApp token. A preflight that blocked the local stack on an
# unrelated credential is one people would route around within a week.
#
# Skipped in CI, which runs this script too. A GitHub runner has no global
# pnpm or terraform -- it installs what it needs through actions -- so the
# preflight found them missing and blocked docker-smoke. This check is a
# DEVELOPER aid: on a runner there is no shell profile to repair and nobody
# to ask, and the jobs that need a tool already install it themselves.
if [ -z "${CI:-}" ]; then
  sh "$(dirname "$0")/check-local-env.sh" --fix --gate-stack
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed. Get it from https://docs.docker.com/get-docker/ and re-run this script." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker is installed, but the 'docker compose' plugin isn't available. Update Docker Desktop / install the compose plugin and re-run." >&2
  exit 1
fi

echo "==> Starting Postgres + Redis..."
docker compose up -d postgres redis

echo "==> Waiting for Postgres to accept connections..."
until docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done

echo "==> Building the API image (first run installs all dependencies — can take a few minutes)..."
docker compose build api

echo "==> Applying database migrations..."
docker compose run --rm api sh -c "pnpm exec prisma generate && pnpm exec prisma migrate deploy"

echo "==> Seeding sample data..."
docker compose run --rm api pnpm run seed \
  || echo "    (seed step didn't complete cleanly — likely already seeded from a previous run; continuing)"

echo "==> Starting API + web..."
docker compose up -d --build api web

echo "==> Waiting for API + web to accept connections..."
until curl -sf -o /dev/null http://localhost:4000/graphql -X POST \
  -H "Content-Type: application/json" -d '{"query":"{ __typename }"}' 2>/dev/null; do
  sleep 1
done
until curl -sf -o /dev/null http://localhost:3000 2>/dev/null; do
  sleep 1
done

cat <<'EOF'

Ready:
  web   http://localhost:3000
  api   http://localhost:4000/graphql

EOF

# CI (GitHub Actions sets CI=true, as do most other CI providers) needs
# this script to actually exit once the stack is up so the workflow can
# run its own verification steps next — the same script real developers
# run locally, not a separate reimplementation CI trusts blindly. Only
# the interactive tail is CI-inappropriate; everything above it is
# exactly what CI wants to happen too.
if [ -n "${CI:-}" ]; then
  echo "CI environment detected — exiting instead of following logs."
  exit 0
fi

cat <<'EOF'
Watching logs below (Ctrl+C stops watching only — containers keep running
in the background). Run `docker compose down` to stop everything, or
`docker compose down -v` to also wipe the database.

EOF

docker compose logs -f api web
