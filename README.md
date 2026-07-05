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

1. Create a Clerk app and add a JWT template named `convex` (use Clerk's
   Convex preset). Note its issuer domain.
2. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in
   `apps/dashboard/.env.local`. `ClerkProvider`, `ConvexProviderWithClerk`,
   sign-in UI, and `apps/dashboard/proxy.ts` activate automatically once the
   key is present — do not run `clerk init`; the wiring already exists.
3. Copy `packages/backend/auth.config.example.ts` to
   `packages/backend/convex/auth.config.ts` (gitignored) and set
   `CLERK_JWT_ISSUER_DOMAIN` in Convex env vars
   (`pnpm --filter @household/backend exec convex env set ...`) **in the same
   sitting**: Convex refuses to push an auth config whose env var is unset,
   and once pushed, that deployment rejects anonymous access. Keep the file
   absent for anonymous local dev.
4. Sign in once, then set `CLERK_ALLOWED_SUBJECTS` to the comma-separated
   `user_...` ids of the two household members (Clerk dashboard → Users).
   Until it is set, any user who can sign up on your Clerk instance gets in —
   set it promptly or disable public sign-ups in Clerk.
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
`/out <item>`, `/set <item> <count>`, `/cart`, and `/jobs`. Plain text like
"used up the coffee" goes through the parser tier (model from `ai_config`);
low-confidence parses ask before writing, and ambiguous item names offer
inline-keyboard choices.

The bot also pushes notifications to the allowed chats: new proposed carts
(Approve button), checkout summaries awaiting confirmation (screenshot +
total + Confirm button, withheld when the summary diff fails policy), captcha
pauses, completions, and a Sunday-evening reconciliation nudge.

For deployed Convex with Clerk enabled, set `BOT_CONVEX_TOKEN` in the bot
environment and in Convex env vars. The same shared secret pattern can reuse
`WORKER_TOKEN`, but keeping a separate bot token is cleaner.

## Worker (Phase 2)

The worker subscribes to queued purchase jobs, drives the store in a local
Chrome via Stagehand, and runs the full confirm handshake. Environment:

```bash
CONVEX_URL=...                # Convex deployment URL
WORKER_TOKEN=...              # must match the Convex env var
WORKER_ID=vps-1
ANTHROPIC_API_KEY=...         # deliberate opt-in (D11), but required for any
                              # stagehand run that isn't a fully cached replay
                              # (first contact, healing, spike observe/heal)
STAGEHAND_MODEL=anthropic/claude-haiku-4-5   # optional override
WORKER_PROFILE_ROOT=~/.household-manager/profiles
WORKER_SECRETS_FILE=/path/to/secrets.json    # chmod 600; see src/secrets.ts schema
WORKER_CDP_PORT=9222
WORKER_HEADLESS=false         # keep headful on the VPS (noVNC recovery, bot posture)
HARNESS_ALLOW_API_BILLING=false  # D11: harness child only gets ANTHROPIC_API_KEY when "true"
HARNESS_CLI=claude            # optional override of executor_config.harness_cli
pnpm --filter @household/worker dev
```

Executor routing is resolved when a cart is queued: explicit choice >
per-store override > explorer executor for a store with no recorded
trajectories (first contact) > configured default. The seed pins Tienda Kay
to stagehand via `executor_override` and sets the explorer executor to
harness, so a brand-new store (Mercado Libre) routes to the harness on first
contact. The harness executor runs `claude -p` with only the Playwright MCP
attached to the worker's Chrome over CDP — no shell or filesystem tools, and
card entry never goes through it.

One-time per store, log in manually so the persistent profile holds the
session. The `<store>` argument accepts the store's `login_ref`, name, or
Convex id — it is resolved to the store `_id`, the key the persistent
profile lives under (the same one real purchase jobs open):

```bash
pnpm --filter @household/worker login <store> https://store-domain/account
```

### S2.0 spike

Run the plan's S2.0 checklist before trusting the trajectory cache
(`pnpm --filter @household/worker spike -- <cmd> ...`):

1. `spike launch <store> <url>` — verify profile + CDP persistence across
   restart/reboot, and that Playwright MCP can attach to the printed endpoint.
   Chrome binds CDP to `127.0.0.1`, so verify with
   `curl http://127.0.0.1:9222/json/version` on the machine itself (or over
   an SSH tunnel), not against a remote IP.
2. `spike observe <store> <url> "<instruction>" action.json` — resolve and
   persist an action object (needs `ANTHROPIC_API_KEY`).
3. `spike replay <store> <url> action.json` — must report zero LLM tokens.
4. Sabotage the selector in `action.json`, then
   `spike heal <store> <url> action.json "<instruction>"` — verifies the
   heal path (needs `ANTHROPIC_API_KEY`).

`<store>` accepts the store's `login_ref`, name, or Convex id.

## First VPS Gate

Before real purchases, complete Phase 1.5 from `IMPLEMENTATION_PLAN.md`:
provision the VPS, set up noVNC over Tailscale/SSH, verify persistent
browser profiles, and record store/IP behavior. The step-by-step commands —
display stack, systemd units, secrets file, spike checklist, and the first
watched purchase — live in [docs/vps-runbook.md](docs/vps-runbook.md).
