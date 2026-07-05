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

To configure anonymous local Convex development:

```bash
pnpm --filter @household/backend dev
```

Then seed defaults in another terminal:

```bash
pnpm --filter @household/backend exec convex run seed:defaults '{"workerToken":"local-dev"}'
```

For this local-only setup, the dashboard uses `apps/dashboard/.env.local` with:

```bash
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210
```

## First VPS Gate

Before real purchases, complete Phase 1.5 from `IMPLEMENTATION_PLAN.md`: provision the VPS, set up noVNC over Tailscale/SSH, verify persistent browser profiles, and record store/IP behavior.
