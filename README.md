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

## Dashboard Auth

Local development runs anonymously until Clerk is configured. For deployed
Phase 1 auth:

1. Create a Clerk app and enable a Convex JWT template named `convex`.
2. Copy `packages/backend/auth.config.example.ts` to
   `packages/backend/convex/auth.config.ts`.
3. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in the
   dashboard environment.
4. Set `CLERK_JWT_ISSUER_DOMAIN` and `CLERK_ALLOWED_SUBJECTS` in Convex env
   vars. `CLERK_ALLOWED_SUBJECTS` is a comma-separated list of the two allowed
   Clerk user subjects.
5. Set `WORKER_TOKEN` in Convex env vars before deploying: `seed:defaults` and
   all worker/bot mutations refuse to run on a Clerk-configured deployment
   without it.

The parser action reads its model from the `ai_config` table (editable in the
dashboard Config panel); the `PARSER_MODEL` env var is only a fallback.

## Telegram Bot

Create a bot with BotFather, then run long polling locally or on the VPS:

```bash
CONVEX_URL=http://127.0.0.1:3210 \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_ALLOWED_USER_IDS=123456789 \
pnpm --filter @household/bot dev
```

Commands include `/stock`, `/low`, `/add <item> [qty]`, `/use <item> [qty]`,
`/out <item>`, `/set <item> <count>`, `/cart`, and `/jobs`.

For deployed Convex with Clerk enabled, set `BOT_CONVEX_TOKEN` in the bot
environment and in Convex env vars. The same shared secret pattern can reuse
`WORKER_TOKEN`, but keeping a separate bot token is cleaner.

## First VPS Gate

Before real purchases, complete Phase 1.5 from `IMPLEMENTATION_PLAN.md`: provision the VPS, set up noVNC over Tailscale/SSH, verify persistent browser profiles, and record store/IP behavior.
