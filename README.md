<div align="center">

# MedInstru Market

**B2B marketplace for medical &amp; surgical instruments.**
India + US, low-bandwidth-first.

[![Launch app](https://img.shields.io/badge/%F0%9F%9A%80_Launch_app-medinstru--web.onrender.com-4f46e5?style=for-the-badge)](https://medinstru-web.onrender.com)

*Free-tier host — a cold first request can take 30–50s to spin up.*

[![CI](https://img.shields.io/github/actions/workflow/status/nixsin/marketplace/ci.yml?label=CI&logo=githubactions&logoColor=white)](https://github.com/nixsin/marketplace/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/nixsin/marketplace/codeql.yml?label=CodeQL&logo=github&logoColor=white)](https://github.com/nixsin/marketplace/actions/workflows/codeql.yml)
[![Docker scan](https://img.shields.io/github/actions/workflow/status/nixsin/marketplace/docker-scan-scheduled.yml?label=docker%20scan&logo=docker&logoColor=white)](https://github.com/nixsin/marketplace/actions/workflows/docker-scan-scheduled.yml)
[![Dependency freshness](https://img.shields.io/github/actions/workflow/status/nixsin/marketplace/dependency-freshness.yml?label=deps&logo=dependabot&logoColor=white)](https://github.com/nixsin/marketplace/actions/workflows/dependency-freshness.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=nodedotjs&logoColor=white)](package.json)

[![API coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nixsin/marketplace/gh-pages/coverage/api-badge.json)](https://nixsin.github.io/marketplace/coverage/index.html)
[![Web coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nixsin/marketplace/gh-pages/coverage/web-badge.json)](https://nixsin.github.io/marketplace/coverage/index.html)
[![Lighthouse](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nixsin/marketplace/gh-pages/coverage/lighthouse-badge.json)](https://nixsin.github.io/marketplace/coverage/index.html)
[![Accessibility](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/nixsin/marketplace/gh-pages/coverage/accessibility-badge.json)](https://nixsin.github.io/marketplace/coverage/index.html)

**[📈 Metrics dashboard](https://nixsin.github.io/marketplace/coverage/index.html)** — coverage, Lighthouse, and accessibility, charted over time

</div>

---

## Quick start

```bash
./scripts/dev.sh
```

One command, one prerequisite ([Docker](https://docs.docker.com/get-docker/)): builds both apps, runs migrations, seeds sample data, and starts everything.

- web → http://localhost:3000
- api → http://localhost:4000/graphql

→ **[docs/development.md](./docs/development.md)** for the full setup (including running natively without Docker), testing commands, and what's scaffolded so far.

## Stack

| | |
|---|---|
| **Web** | Next.js (App Router) · TypeScript · Tailwind · shadcn/ui |
| **API** | NestJS · GraphQL (Apollo) · Prisma · Postgres |
| **Repo** | pnpm workspace monorepo — `apps/web`, `apps/api`, `packages/*` (shared code, Phase 1+) |
| **Deploy** | Render, Docker-based — see [docs/deployment.md](./docs/deployment.md) |

## Documentation

| | |
|---|---|
| [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md) | Architecture, data model, roles, full roadmap — **read this first** for anything beyond setup |
| [docs/development.md](./docs/development.md) | Local setup, running the apps, testing |
| [docs/caching-and-performance.md](./docs/caching-and-performance.md) | Shell/data split, GraphQL-over-GET caching, minification, security headers |
| [docs/localization.md](./docs/localization.md) | English/Hindi routing, instant client-side language switching |
| [docs/deployment.md](./docs/deployment.md) | Environment variables, Render setup |
| [CLAUDE.md](./CLAUDE.md) | CI/CD pipeline, review gates, operational playbook — for whoever's maintaining this repo day to day |

## Status

**Phase 0**: repo skeleton + auth/org onboarding foundation, plus first-visit performance and caching hardening. Not yet built: catalog, search, RFQ engine, lead distribution, messaging, billing, admin console — see TECHNICAL_PLAN.md §9 for the full roadmap.
