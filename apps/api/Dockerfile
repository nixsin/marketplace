# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable

# ---- deps: installed once here, reused by both the dev and build stages
# below via Docker's layer cache — only invalidates when a manifest or the
# lockfile changes, not on every source edit. pnpm needs the *whole*
# workspace's package.json files present (not just this app's) to resolve
# the monorepo correctly, even though we only end up running apps/api.
FROM base AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
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
FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/src/main.js"]
