# Household Manager

Private household stock, cart, and purchase-automation workspace.

## Packages

- `packages/backend`: Convex schema, functions, crons, parser action, and seed mutation.
- `packages/shared`: shared TypeScript/Zod state and result schemas.
- `apps/dashboard`: Next.js operational dashboard scaffold.
- `apps/worker`: VPS worker skeleton with Convex subscriptions, executor boundaries, and harness isolation.
- `apps/bot`: grammY Telegram bot skeleton.

## Local Setup

```bash
pnpm install
pnpm typecheck
pnpm build
```

Convex codegen is skipped until a deployment is configured. To configure Convex:

```bash
pnpm --filter @household/backend dev
```

Then seed defaults:

```bash
pnpm --filter @household/backend exec convex run seed:defaults '{"workerToken":"<WORKER_TOKEN>"}'
```

## First VPS Gate

Before real purchases, complete Phase 1.5 from `IMPLEMENTATION_PLAN.md`: provision the VPS, set up noVNC over Tailscale/SSH, verify persistent browser profiles, and record store/IP behavior.
