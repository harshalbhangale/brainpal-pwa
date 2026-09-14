# BrainPal

One installable family app where specialist AI companions work together.
**MoneyPAL** helps with money, **TutorPAL** helps with learning, and **BrainPal**
coordinates them while parents stay in control of important decisions.

Build plan and phase specs live in [`Docs/`](./Docs).

## Rules that never change

1. One request has one owning PAL.
2. Agents explain and propose; trusted services execute.
3. Important actions require a clear preview and confirmation.
4. Voice alone never authorises money movement.
5. Balances, permissions and results come from databases — not model memory.
6. Every consequential action is idempotent and auditable.
7. Child data is private, scoped and correctable.
8. TutorPAL may recommend rewards; MoneyPAL owns real-value reward proposals.
9. The PWA must provide a normal screen-based fallback when AI is unavailable.
10. The first release proves a few complete loops before expanding the feature list.

## Layout

```
apps/
  web/          Next.js PWA
  api/          Fastify + Mastra
  worker/       document, vision and async jobs
packages/
  contracts/    zod schemas — the wire contract between every layer
  database/     schema and migrations
  auth/         session and role derivation
  brainpal/     orchestrator and model registry
  moneypal/     MoneyPAL agent
  tutorpal/     TutorPAL agent
  trust/        policy checks
  memory/       approved facts and preferences
  observability/ agent run tracing
  ui/           shared components, incl. BrainPalAvatar
infra/          AWS CDK
evals/          per-PAL evaluation sets
```

## Getting started

Requires Node 22+, pnpm and Docker.

```bash
pnpm install
cp .env.example .env.local     # then fill in OPENAI_API_KEY and the model roles
pnpm services:up               # Postgres (pgvector) on :5433 + Redis on :6379
pnpm --filter @brainpal/database db:migrate
pnpm dev
```

Postgres is published on **5433**, not 5432, so it cannot collide with a Postgres
already installed on the machine. Tests that need a database read `DATABASE_URL`
and skip when it is unset.

## Current status

**Phase 1 — Foundation & BrainPal OS**, in progress.

| | |
|---|---|
| Workspace, Turborepo, TypeScript base | done |
| Local services (Postgres + Redis) | done |
| `@brainpal/contracts` | done |
| `@brainpal/database` | done |
| `@brainpal/auth` | done (mock verifier; Cognito pending) |
| `apps/api` — health, me, family, pals, threads | done |
| `apps/api` — `POST /v1/agent/turn` | next |
| `packages/brainpal` orchestrator | next |
| `apps/web` | next |
| Avatar system | next |

Phase 1 is complete when a parent can log in, create a family, add a child, the
child can pick an avatar, and a question routes to the right PAL and streams an
answer into one persisted thread.
