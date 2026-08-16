# syntax=docker/dockerfile:1

FROM node:26-alpine AS base
# Node 26 stopped bundling corepack — install it explicitly before enabling
# (it still reads the pnpm version to use from package.json's packageManager
# field, same as before).
RUN npm install -g corepack && corepack enable

# ---- deps: see apps/api/Dockerfile for why the whole workspace's
# package.json files are needed here, not just apps/web's — and, for the
# same reason, apps/api's prisma schema: a workspace-root `pnpm install`
# runs every package's postinstall, including apps/api's `prisma generate`,
# even in a build that never otherwise touches the API app.
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
RUN pnpm install --frozen-lockfile

# ---- dev: source is bind-mounted in by docker-compose.yml, not copied in
# here — Next's dev server needs nothing baked in beyond installed deps.
FROM deps AS dev
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["pnpm", "dev"]

# ---- build: compiled .next output for the prod stage below.
#
# Tried Next's `output: "standalone"` first (a self-contained server
# bundle, smaller than shipping full node_modules) — abandoned after it
# reliably crashed on boot with `Cannot find module '.../@swc/helpers/
# esm/...'`. Confirmed by extracting the built image: Next's file tracer
# only copied the `cjs/` half of its own internal @swc/helpers copy, not
# `esm/`, and adding @swc/helpers as an explicit workspace dependency
# didn't help — the missing copy lives nested inside next's own
# node_modules (pnpm isolates it there), not at the top level a workspace
# dependency would resolve to. This reproduced consistently across
# rebuilds, so it's the tracer under-collecting files, not a fluke.
# `pnpm deploy` (see apps/api/Dockerfile for why not a plain `COPY
# node_modules`) sidesteps the tracer entirely by shipping the real,
# complete node_modules instead of Next's best-effort subset — bigger
# image, but correct, which matters more before this ever gets optimized.
FROM deps AS build
WORKDIR /repo
COPY apps/web apps/web
# NEXT_PUBLIC_* vars are inlined into the client bundle at `next build` time,
# not read at container startup — so setting NEXT_PUBLIC_API_URL as a runtime
# env var on the host (e.g. Render) has no effect on its own. Render (and
# `docker build --build-arg`) both translate matching env vars/build args
# into this ARG automatically; the ENV line below is what actually exposes
# it to the `next build` process.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/graphql
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter web build
RUN pnpm --filter web deploy --prod --legacy /out

# ---- prod: no pnpm, no workspace, no dev deps — but not minimal in the
# way the abandoned standalone approach would have been (see above).
FROM node:26-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
# See apps/api/Dockerfile for why: node:22-alpine's bundled npm is never
# invoked here (CMD below runs the `next` binary directly) but still
# shows up as real CVEs in a vulnerability scan of the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/web/.next ./.next
COPY --from=build /repo/apps/web/public ./public
COPY --from=build /repo/apps/web/package.json ./package.json
# `next build` resolves next.config.ts into .next/required-server-files.json,
# but `next start` still needs the file itself on disk at boot for anything
# handled by its own runtime route (the /_next/image optimizer, in
# particular) rather than the prebuilt manifest — without it, `next start`
# silently falls back to default config instead of erroring, so this was a
# quiet breakage: images.dangerouslyAllowSVG reverted to its default `false`
# and every SVG product image 400'd in production. next.config.ts's only
# import (next-intl/plugin) is a real runtime dependency, already present in
# node_modules above, so this is safe to load with no other deps.
COPY --from=build /repo/apps/web/next.config.ts ./next.config.ts
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
