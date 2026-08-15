# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable

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
RUN pnpm --filter web build
RUN pnpm --filter web deploy --prod --legacy /out

# ---- prod: no pnpm, no workspace, no dev deps — but not minimal in the
# way the abandoned standalone approach would have been (see above).
FROM node:22-alpine AS prod
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
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
