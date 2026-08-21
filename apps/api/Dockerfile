# syntax=docker/dockerfile:1

FROM node:26-alpine AS base
# Node 26 stopped bundling corepack — install it explicitly before enabling
# (it still reads the pnpm version to use from package.json's packageManager
# field, same as before).
RUN npm install -g corepack && corepack enable

# ---- deps: installed once here, reused by both the dev and build stages
# below via Docker's layer cache — only invalidates when a manifest, the
# lockfile, or the Prisma schema changes, not on every source edit. pnpm
# needs the *whole* workspace's package.json files present (not just this
# app's) to resolve the monorepo correctly, even though we only end up
# running apps/api.
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# apps/api now depends on @medinstru/config directly (shared header,
# correlation and auth-lifetime values), and the workspace root declares
# it too for the scripts/*.mjs automations -- either way `pnpm install`
# must be able to resolve the workspace link or it fails outright.
# Manifest only at this stage; the real source is copied in `build`, and
# again into `prod` over pnpm's dangling symlink. All three are required
# and they fail in three unrelated-looking ways -- see those stages.
COPY packages/config/package.json packages/config/package.json
# apps/api's postinstall runs `prisma generate`, which needs its schema —
# copied ahead of the full source (below, in later stages) for the same
# layer-caching reason as the package.json files above.
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
RUN pnpm install --frozen-lockfile

# ---- dev: source is bind-mounted in by docker-compose.yml, not copied in
# here — this stage only needs the installed deps. Prisma's generated
# client (apps/api/generated/) is gitignored and schema-derived, so it's
# regenerated on every container start rather than baked into the image;
# cheap, and guarantees it can never go stale against a locally-edited
# schema.prisma.
FROM deps AS dev
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["sh", "-c", "pnpm exec prisma generate && pnpm start:dev"]

# ---- build: compiled output for the prod stage below.
FROM deps AS build
WORKDIR /repo
COPY apps/api apps/api
# apps/api imports @medinstru/config, and the deps stage only copied that
# package's manifest (enough to resolve the workspace link, not to run
# it). Without the real source here the build fails resolving the import.
COPY packages packages
RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build
# `pnpm deploy` (not a plain `cp`/`COPY node_modules`) because pnpm's
# node_modules is a tree of symlinks into a shared content-addressable
# store — copying it as-is into the prod stage below would carry over
# symlinks pointing at a store path that stage doesn't have, i.e. every
# dependency would resolve to a dangling link. `deploy` materializes a
# real, self-contained node_modules for just this one workspace package.
# `--legacy`: pnpm 10+ defaults to requiring injected workspace deps
# (`inject-workspace-packages=true`) for the non-legacy deploy path, which
# this workspace doesn't set (apps/api and apps/web don't depend on each
# other) — without this flag the build fails outright with
# ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE.
RUN pnpm --filter api deploy --prod --legacy /out

# ---- prod: minimal runtime image — no pnpm, no workspace, no dev deps.
FROM node:26-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
# node:22-alpine ships a global npm install we never invoke (CMD below
# calls `node` directly) — removed rather than left in place, since a
# vulnerability scan of the final image otherwise flags real CVEs in
# npm's own bundled dependencies (brace-expansion, tar, etc.) that pose
# zero actual risk here but would still fail a scan gate for something
# not even reachable at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /out/node_modules ./node_modules
# THE NON-OBVIOUS ONE, and the one that builds clean and crashes at boot.
# `pnpm deploy --legacy` does NOT materialize workspace dependencies: it
# writes node_modules/@medinstru/config as a SYMLINK to a build-stage path
# that does not exist here, so the line above lands a dangling link and the
# container dies with MODULE_NOT_FOUND after logging a successful start.
# apps/web hit exactly this on 2026-08-19; copying the real directory over
# the symlink's location is explicit and does not depend on whatever
# relative depth pnpm happens to generate.
# The rm is not redundant. COPY onto a path that is already a symlink
# FOLLOWS it rather than replacing it -- verified directly: without this,
# the link survived and Docker wrote the files to its target
# (/repo/packages/config), which happened to make the import resolve for a
# reason no one reading this would predict. Deleting first guarantees a
# real directory at the path Node actually looks in.
RUN rm -rf ./node_modules/@medinstru/config
COPY --from=build /repo/packages/config ./node_modules/@medinstru/config
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/src/main.js"]
