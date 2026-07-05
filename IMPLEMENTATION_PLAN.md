# Household Manager — Implementation Plan

**Status:** Ready to start; purchasing is gated by the VPS/browser/IP spike
**Based on:** `household-manager-design.md` (2026-07-04)
**Last updated:** 2026-07-04

This plan turns the design doc into a concrete build sequence. Where it deviates from the
design, the deviation and rationale are listed in §1. Library facts below were verified
against current docs/issues (July 2026), not assumed.

---

## 1. Decisions & deviations from the design doc

| #   | Decision                                                                                                                                                                                                                                                                                                                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **We own the trajectory cache; Stagehand's automatic caching is treated as untrusted.** Cache = persisted `observe()` action objects stored in Convex, replayed via `act(actionObject)` (zero LLM calls), with per-step fallback to a fresh LLM `act()` on failure (manual self-heal).                                           | Verified: Stagehand's server-side cache has reported silent failures ([#1767](https://github.com/browserbase/stagehand/issues/1767)); flow-level caching isn't reliable; agent-cache skips custom tool calls ([#1558](https://github.com/browserbase/stagehand/issues/1558)). The documented `observe()`-persist-replay pattern is the reliable path and gives us auditability for free. |
| D2  | **The worker runs on a VPS and owns the browser session.** Stagehand launches/keeps alive local Chrome with a persistent profile, fixed CDP port, and `keepAlive`; the harness attaches to that CDP endpoint.                                                                                                                    | We do **not** run a Raspberry Pi or home machine. Stagehand's documented local launch options cover persistent `userDataDir`, fixed CDP port, and keep-alive behavior; generic attach-to-worker-launched-Chrome remains an S2.0 spike/fallback, not the default. The same browser/profile survives the two-invocation harness checkpoint.                                                |
| D3  | **Two-invocation harness protocol** for the human checkpoint in Option B: invocation 1 builds cart → order summary → screenshot → exits; human approves; invocation 2 attaches to the same live browser and clicks confirm.                                                                                                      | The design flagged "checkpoint is harder to insert in a black-box loop" as a trade-off. This dissolves it: the checkpoint lives in the _worker_ between two harness calls, identical in shape to the Stagehand path.                                                                                                                                                                     |
| D4  | **Dashboard auth: Clerk** (free tier, 2 users), not Convex Auth.                                                                                                                                                                                                                                                                 | Convex Auth is still beta (July 2026). Clerk + Convex is the most-documented, stable integration; zero cost at this scale. Swap later if desired.                                                                                                                                                                                                                                        |
| D5  | **Worker/bot auth to Convex: shared-secret argument** — mutations reserved for machines take a `workerToken` arg validated against a Convex env var.                                                                                                                                                                             | Simple, adequate for a 2-person private app; avoids wiring machine identities through Clerk.                                                                                                                                                                                                                                                                                             |
| D6  | **LLM API keys may live in Convex _environment variables_** (for the parser tier running as a Convex action). Card data, store credentials, session cookies remain worker-only, per the design.                                                                                                                                  | The design's "no API keys in Convex" (§16) conflated env vars with the database. Convex env vars are a proper secret store; the real rule is: **never in tables, logs, code, or URLs**. The parser is most naturally a Convex action.                                                                                                                                                    |
| D7  | **Basic reconciliation UI ships in Phase 1**, not Phase 6 (Telegram reconciliation prompts stay in Phase 5/6).                                                                                                                                                                                                                   | Par-level math starts drifting from day one of logging; a dashboard sweep view is cheap and keeps Phase 2+ cart proposals trustworthy.                                                                                                                                                                                                                                                   |
| D8  | **Nightly cron scheduled in UTC** (Convex crons are UTC-only): `03:00 America/Argentina/Buenos_Aires` = `06:00 UTC` (ART has no DST).                                                                                                                                                                                            | Verified limitation; trivial constant.                                                                                                                                                                                                                                                                                                                                                   |
| D9  | **Job pickup: plain `purchase_jobs` table + `ConvexClient.onUpdate()` subscription + lease-based claim mutation.** Not `@convex-dev/workpool`.                                                                                                                                                                                   | Workpool executes inside Convex actions; our execution is an _external_ process with a browser. Verified that `ConvexClient` (npm `convex`) supports `onUpdate` subscriptions from plain Node.                                                                                                                                                                                           |
| D10 | **`awaiting_confirm` gets a deadline** (default 30 min, config). On expiry: job → `expired`, browser session closed, cart returns to `approved` for one-tap re-queue.                                                                                                                                                            | The design leaves the wait unbounded; a browser can't sit on a checkout page for hours (session/stock expiry on the store side). Re-running from cache is cheap.                                                                                                                                                                                                                         |
| D11 | **Subscription harness is optional and usage-limit aware.** `claude -p`/Agent SDK can draw from Pro/Max plan limits that are shared with Claude chat/Claude Code; hitting the limit must pause the job, not break purchasing. `ANTHROPIC_API_KEY` env override is treated as billing-sensitive and never inherited accidentally. | This directly addresses the Fable 5 planning-session failure mode: subscription agents are powerful but quota-bound. Option A (Stagehand/API-key path) must stand alone; Option B is explorer/fallback, with `paused_limit`, retry-after handling, and optional pay-as-you-go/API fallback where explicitly configured.                                                                  |
| D12 | **VPS IP strategy: Argentina VPS first, per-store proxy only if proven necessary.** Use an Argentina/Buenos Aires VPS when practical. Start proxy-less for Tienda Nube shops; add a per-store sticky Argentine residential/ISP proxy only when Mercado Libre/VTEX/Carrefour consistently challenge the VPS datacenter IP.        | Moving off the home connection removes the residential-IP signal from the bot-detection posture. The compensating controls are AR geolocation, real persistent Chrome profiles, human-paced cadence, no rotating IPs mid-session, and a proxy escape hatch that is tested per store instead of assumed.                                                                                  |
| D13 | **Final confirmation is explicitly idempotent.** Before clicking the final buy button, the worker moves the job into `confirming`. If the process crashes or outcome is unknown after that point, the job goes to `needs_reconciliation`; it is never auto-retried by clicking confirm again.                                    | Prevents the worst failure mode: double-purchasing after a crash between "confirmar compra" and `completeJob`. Recovery inspects the store order history/receipt manually or via a read-only reconciliation flow.                                                                                                                                                                        |
| D14 | **Checkout summaries are validated and redacted before approval.** The approval gate compares expected lines/quantities/prices against extracted summary lines, delivery, substitutions, fees, and total; screenshots are locally redacted and short-lived.                                                                      | A screenshot plus total is not enough to safely buy groceries. The user must approve the actual order contents, and Convex must not become a long-term store for addresses, partial card data, phone numbers, or checkout screenshots.                                                                                                                                                   |

Everything else in the design doc stands as written: architecture (§4), consumption model (§5),
approval policy (§6), AI tiers (§7), payment/security (§10), bot-detection posture (§11),
store priority order (§3).

---

## 2. Tech stack (pinned intent, not versions)

- **Backend:** Convex (free tier verified sufficient: 1M function calls/mo, 0.5 GB DB, 1 GB file storage).
- **Dashboard:** Next.js (App Router) + Clerk + `convex/react`. Deployed on Vercel free tier (preferred so approvals work away from home) or on the VPS if we want fewer services.
- **Worker:** Node 22 + TypeScript, plain long-running process under `systemd` on an Ubuntu VPS, preferably Argentina/Buenos Aires geolocated. Minimum 2 vCPU / 4 GB RAM; 4 vCPU / 8 GB preferred for Chrome + Playwright MCP + occasional harness runs. Uses `ConvexClient` from the `convex` package.
- **Executor A:** `@browserbasehq/stagehand` v3 (3.4+), `env: "LOCAL"`, model via `"provider/model"` string (default `"anthropic/claude-haiku-4-5"`, from `ai_config`).
- **Executor B:** `claude -p --bare --strict-mcp-config --mcp-config <playwright-mcp.json> --tools "" --output-format json --json-schema ...` (or a similarly locked-down `codex exec` path), Playwright MCP attached to the worker-owned Chrome via `--cdp-endpoint`.
- **Remote browser access:** Chrome runs under a real display (`Xvfb`/desktop session) with noVNC exposed only over Tailscale or SSH tunnel for manual logins, captcha recovery, and unknown-outcome reconciliation.
- **Telegram:** grammY, **long-polling** (works without webhook/public bot ingress), inline-keyboard callbacks for approve/confirm, `chat_id` allowlist of exactly two users.
- **Parser tier:** Vercel AI SDK `generateObject` + Zod inside a Convex action; model from `ai_config` (default Haiku-class).
- **Monorepo:** pnpm workspaces + turborepo (optional).

### Repo layout

```
household-manager/
  packages/
    backend/            # Convex project (schema, functions, crons) — generated api imported by all apps
      convex/
        schema.ts
        crons.ts
        items.ts  stock.ts  carts.ts  jobs.ts  ledger.ts  config.ts  trajectories.ts
        parser.ts          # action: free-text → stock_event (Phase 5)
    shared/             # Zod schemas, TS types, constants (state machines, statuses)
  apps/
    dashboard/          # Next.js
    worker/             # the hands
      src/
        index.ts        # subscribe → claim → execute loop
        browser.ts      # Chrome lifecycle (launch, profile dirs, CDP endpoint)
        executors/
          types.ts      # Executor interface
          stagehand.ts
          harness.ts
        trajectory.ts   # load/replay/heal/save trajectories (Convex-backed)
        secrets.ts      # card + store + proxy credentials from encrypted VPS secret store
    bot/                # grammY Telegram bot (Phase 5; can run on the same VPS)
```

---

## 3. Convex schema (final draft)

Refinements over the design's §12: indexes, audit events, per-store product mappings,
lease fields on jobs, confirm deadline, trajectories table, single-document config pattern,
and the `expired`, `paused_limit`, `confirming`, and `needs_reconciliation` statuses.

```ts
export default defineSchema({
  items: defineTable({
    name: v.string(),
    aliases: v.array(v.string()),
    category: v.string(),
    unit: v.string(),
    reorder_point: v.number(),
    reorder_to: v.number(),
    preferred_store_id: v.id("stores"),
    substitute_item_ids: v.array(v.id("items")),
    active: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_active", ["active"]),

  stores: defineTable({
    name: v.string(),
    platform: v.union(
      v.literal("tiendanube"),
      v.literal("mercadolibre"),
      v.literal("coto"),
      v.literal("vtex"),
    ),
    domain: v.string(),
    login_ref: v.string(), // key into worker-side secret store, never the secret
    proxy_ref: v.optional(v.string()), // key into worker-side proxy secret/config, never the secret
    proxy_policy: v.union(
      v.literal("none"),
      v.literal("if_challenged"),
      v.literal("required"),
    ),
    shipping_preference: v.string(),
    executor_override: v.optional(
      v.union(v.literal("stagehand"), v.literal("harness")),
    ),
    active: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_active", ["active"])
    .index("by_domain", ["domain"]),

  store_items: defineTable({
    item_id: v.id("items"),
    store_id: v.id("stores"),
    name: v.string(),
    product_url: v.optional(v.string()),
    sku: v.optional(v.string()),
    variant: v.optional(v.string()),
    pack_size: v.optional(v.string()),
    search_terms: v.array(v.string()),
    last_seen_price: v.optional(v.number()),
    active: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_item_store", ["item_id", "store_id"])
    .index("by_store_active", ["store_id", "active"]),

  stock_events: defineTable({
    item_id: v.id("items"),
    delta: v.number(),
    reason: v.union(
      v.literal("manual"),
      v.literal("telegram"),
      v.literal("parser"),
      v.literal("received"),
      v.literal("reconciliation"),
    ),
    source_user: v.optional(v.string()),
    cart_id: v.optional(v.id("carts")),
    job_id: v.optional(v.id("purchase_jobs")),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_item", ["item_id"])
    .index("by_item_created", ["item_id", "created_at"]),
  // current stock = materialized per-item counter `items_stock` table OR sum on read.
  // v1: sum on read with by_item index; catalog is bounded (~50-150 items), fine.

  carts: defineTable({
    store_id: v.id("stores"),
    status: v.union(
      v.literal("proposed"),
      v.literal("approved"),
      v.literal("executing"),
      v.literal("awaiting_confirm"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    lines: v.array(
      v.object({
        item_id: v.id("items"),
        store_item_id: v.optional(v.id("store_items")),
        qty: v.number(),
        expected_unit_price: v.optional(v.number()),
        note: v.optional(v.string()),
      }),
    ),
    approved_by: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_store_status", ["store_id", "status"]),

  purchase_jobs: defineTable({
    cart_id: v.id("carts"),
    store_id: v.id("stores"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("awaiting_confirm"),
      v.literal("confirmed"),
      v.literal("confirming"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("paused_captcha"),
      v.literal("paused_limit"),
      v.literal("expired"),
      v.literal("needs_reconciliation"),
    ),
    executor: v.union(v.literal("stagehand"), v.literal("harness")),
    // lease-based claim (safe across worker restarts):
    claimed_by: v.optional(v.string()), // worker instance id
    lease_expires_at: v.optional(v.number()),
    // human checkpoint:
    order_summary_screenshot: v.optional(v.id("_storage")),
    order_summary_screenshot_expires_at: v.optional(v.number()),
    order_summary_total: v.optional(v.number()), // extract()ed total, shown next to screenshot
    order_summary_currency: v.optional(v.literal("ARS")),
    summary_line_items: v.optional(
      v.array(
        v.object({
          item_id: v.optional(v.id("items")),
          store_item_id: v.optional(v.id("store_items")),
          name: v.string(),
          qty: v.number(),
          unit_price: v.optional(v.number()),
          line_total: v.optional(v.number()),
          status: v.union(
            v.literal("expected"),
            v.literal("substituted"),
            v.literal("unavailable"),
            v.literal("extra"),
          ),
        }),
      ),
    ),
    summary_shipping_total: v.optional(v.number()),
    summary_delivery_window: v.optional(v.string()),
    summary_diff: v.optional(v.any()), // structured diff for UI; exact schema can evolve
    confirm_deadline: v.optional(v.number()), // now + 30min when → awaiting_confirm
    confirmed_by: v.optional(v.string()),
    confirmed_at: v.optional(v.number()),
    confirm_started_at: v.optional(v.number()), // set before clicking final buy button
    order_ref: v.optional(v.string()),
    error: v.optional(v.string()),
    last_error_code: v.optional(v.string()),
    attempts: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_cart", ["cart_id"])
    .index("by_store_status", ["store_id", "status"]),

  ledger: defineTable({
    job_id: v.id("purchase_jobs"),
    store_id: v.id("stores"),
    status: v.union(
      v.literal("placed"),
      v.literal("received"),
      v.literal("adjusted"),
    ),
    total: v.number(),
    currency: v.literal("ARS"),
    order_ref: v.optional(v.string()),
    receipt_ref: v.optional(v.string()),
    line_items: v.array(
      v.object({ name: v.string(), qty: v.number(), price: v.number() }),
    ),
    placed_at: v.number(),
    received_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_store", ["store_id"])
    .index("by_job", ["job_id"]),

  job_events: defineTable({
    job_id: v.id("purchase_jobs"),
    from_status: v.optional(v.string()),
    to_status: v.string(),
    actor: v.string(), // user id, telegram chat id, or worker instance id
    note: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_job_created", ["job_id", "created_at"]),

  cart_events: defineTable({
    cart_id: v.id("carts"),
    from_status: v.optional(v.string()),
    to_status: v.string(),
    actor: v.string(),
    note: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_cart_created", ["cart_id", "created_at"]),

  trajectories: defineTable({
    // D1: our own cache, source-of-truth in Convex
    store_id: v.id("stores"),
    flow: v.string(), // "login_check" | "add_to_cart" | "checkout_to_summary" | "confirm"
    steps: v.array(
      v.object({
        instruction: v.string(), // the natural-language act instruction (for re-resolution)
        action: v.any(), // persisted observe() action object (replayed with no LLM)
        last_healed_at: v.optional(v.number()),
      }),
    ),
    version: v.number(),
    success_count: v.number(),
    failure_count: v.number(),
    updated_at: v.number(),
  }).index("by_store_flow", ["store_id", "flow"]),

  ai_config: defineTable({
    // one row per tier
    tier: v.union(
      v.literal("parser"),
      v.literal("executor"),
      v.literal("explorer"),
    ),
    provider: v.string(),
    model: v.string(),
  }).index("by_tier", ["tier"]),

  executor_config: defineTable({
    // single document
    default_executor: v.union(v.literal("stagehand"), v.literal("harness")),
    explorer_executor: v.union(v.literal("stagehand"), v.literal("harness")),
    harness_cli: v.optional(
      v.union(v.literal("claude-code"), v.literal("codex")),
    ),
    stagehand_model: v.optional(v.string()),
    vps_region: v.string(), // e.g. "ar-buenos-aires"
    default_proxy_policy: v.union(
      v.literal("none"),
      v.literal("if_challenged"),
    ),
    confirm_timeout_minutes: v.number(), // D10, default 30
  }),
});
```

### State machines

**Cart:** `proposed → approved → executing → awaiting_confirm → completed`
(+ `→ cancelled` from proposed/approved; `→ failed` from executing/awaiting_confirm;
job `expired` sends the cart back to `approved`).

**Purchase job:**

```
queued → running → awaiting_confirm → confirmed → confirming → done
   │        ├→ paused_captcha (human solves over noVNC → resume; or finishes manually)
   │        ├→ paused_limit (Claude/agent/API limit hit → resume/fallback/retry later)
   │        └→ failed
   └ (lease expiry while running → back to queued, attempts++)
awaiting_confirm ─(deadline passes, cron)→ expired   [cart → approved]
confirming ─(crash/unknown outcome)→ needs_reconciliation   [never auto-click confirm again]
```

Guard every transition in mutations (reject illegal moves); the human gate is the
`awaiting_confirm → confirmed` mutation, callable from dashboard or Telegram by either user.
`confirmed → confirming` is worker-only and must happen immediately before the final click.

**Stock accounting:** checkout means "order placed," not "items received." `completeJob`
writes a `ledger` row with `status: "placed"` and the extracted order ref, but does **not**
increase stock. Stock increases later via a receipt/reconciliation flow (`reason: "received"`
or `"reconciliation"`), because online grocery substitutions, cancellations, and delivery
shortages are normal.

### The confirm handshake (worker ↔ Convex), precisely

1. Worker claims job (`claimJob` mutation: sets `running`, `claimed_by`, `lease_expires_at = now+10min`; renews lease every 5 min while executing).
2. Executor drives to order summary. Worker extracts line items, substitutions/unavailable items, fees, delivery window, and total. It locally redacts the screenshot (address/card/phone/order-sensitive regions) before upload (`generateUploadUrl` → POST → storage id), then calls `reachedSummary` → `awaiting_confirm`, `confirm_deadline = now + 30min`. **Browser stays open.**
3. `reachedSummary` computes `summary_diff` against the expected cart. The UI shows redacted screenshot + extracted structured summary + diff. A normal confirm is allowed only when the diff is within policy; otherwise require explicit "place order anyway" override by a user.
4. Worker `onUpdate`-subscribes to that job document; a human taps "Place order" (dashboard/Telegram) → status `confirmed`, `confirmed_by`, `confirmed_at`.
5. Worker sees `confirmed` → calls `startConfirming` mutation (`confirmed → confirming`, `confirm_started_at = now`) **before** clicking the final "confirmar compra" button.
6. Executor clicks the final button once, extracts receipt/order number, then `completeJob` writes `ledger(status: "placed")`, job `done`, cart `completed`. No stock increment happens here.
7. If the worker crashes or the browser outcome is ambiguous after `confirming`, the recovery path marks the job `needs_reconciliation`. It must inspect store order history/receipt state; it must never auto-click final confirm again.
8. If the deadline passes first (Convex cron checks every 5 min): job `expired`, cart back to `approved`; worker sees the transition, closes the store tab gracefully.
9. If Claude Code/agent usage limits or API `429`/`retry-after` interrupts an executor before final confirmation, job → `paused_limit` with retry metadata. Resume later, switch executor if configured, or return cart to `approved`; do not keep a browser waiting past `confirm_deadline`.

---

## 4. Worker design

- **One process, one loop:** on startup, drain all claimable jobs once, then subscribe (`onUpdate`) to `jobs.getQueued`; on new job, attempt lease-claim (mutation is the arbiter — safe if we ever run two workers); execute; write back. Re-drain after reconnect. Serialize job execution (one browser purchase at a time) — human-like cadence per §11 of the design.
- **VPS runtime:** Ubuntu VPS, `systemd` service, encrypted disk or encrypted secrets volume, unattended security updates, firewall closed by default. Browser UI is reachable only through Tailscale/SSH-tunneled noVNC for manual logins, captcha handling, and `needs_reconciliation`; never expose VNC/noVNC directly to the internet.
- **Browser management (D2):** `browser.ts` starts Stagehand in `env: "LOCAL"` with system Chrome/Chromium, `headless: false`, fixed `port`, `userDataDir=~/.household-manager/profiles/<store>`, `preserveUserDataDir: true`, and `keepAlive: true` where supported. One profile per store isolates sessions and matches "log in manually once per store." The fixed CDP endpoint is exposed to Playwright MCP for the harness path. If Stagehand local keep-alive/persistent profile behavior regresses, S2.0 can fall back to worker-launched Chrome + direct Playwright for deterministic steps while Stagehand is used only for `observe`/`act` spikes.
- **Network/IP policy (D12):** default to the VPS's AR-geolocated datacenter IP. For each store, record `proxy_policy` and optional `proxy_ref`. Use no proxy for Tienda Nube unless challenged. For Mercado Libre/VTEX/Carrefour, test datacenter IP first; if it consistently triggers challenges, configure a sticky Argentine residential/ISP proxy for the whole browser profile/session. Do not rotate IPs mid-session, do not outsource captcha solving, and do not treat proxying as a way around explicit account blocks.
- **Executor interface** (unchanged in spirit from design §7.1, adapted to the two-call checkpoint):

```ts
interface Executor {
  // Build cart + drive checkout to the order summary. Returns screenshot + extracted total.
  runToSummary(job: PurchaseJobCtx): Promise<SummaryResult>;
  // Called only after human confirmation. Clicks the final confirm, extracts receipt data.
  confirmPurchase(job: PurchaseJobCtx): Promise<ReceiptResult>;
  abort(job: PurchaseJobCtx): Promise<void>; // expiry / cancellation cleanup
}
```

- **StagehandExecutor:** for each trajectory step: replay persisted `action` via `act(action)`; on failure, re-resolve with LLM `act(instruction)`, persist the healed action back to Convex (`trajectories`), continue. No trajectory yet → run in explore mode (LLM per step or `agent()` for first contact), record every resolved step as a new trajectory.
- **HarnessExecutor (D3/D11):** `runToSummary` = `claude -p --bare --strict-mcp-config --mcp-config <playwright-mcp.json> --tools "" --output-format json --json-schema <SummaryResultSchema> --max-turns <n>` with a store-specific prompt + Playwright MCP (`--cdp-endpoint` at the worker's Chrome) + instruction to stop at the summary. `confirmPurchase` = second short invocation after `startConfirming`: "the order summary is on screen; click the final confirm button once, then report the order number as JSON." Build the child env explicitly from an allowlist; do not inherit `ANTHROPIC_API_KEY` unless this specific run is configured for API billing. If Claude Code reports usage-limit exhaustion, route to `paused_limit` and close/requeue before the checkout page expires.
- **Harness tool boundary:** the harness may control the browser through the configured MCP tools, but it should not get shell/file tools, local secrets, raw card values, or broad filesystem access. Payment entry, if needed, goes through a deterministic worker-owned helper/tool such as `fillPaymentSecret(login_ref/payment_ref)` that returns success/failure and never exposes the underlying secret text to the model transcript.
- **Captcha:** executors detect checkout-blocking captcha (heuristic: `observe()`/prompt reports it) → job `paused_captcha` + Telegram ping with redacted screenshot; the browser is visible on the VPS over noVNC/Tailscale, so a human solves it in place and taps "resume" (job back to `running`) or finishes manually and marks the outcome on the dashboard.
- **Secrets (`secrets.ts`):** card + store credentials + proxy credentials live in an encrypted VPS secret store (`sops` file, age-encrypted env, or OS/keychain equivalent), decrypted into process memory only. `stores.login_ref` and `stores.proxy_ref` name entries. Card values are only typed into pages by worker-owned code/tooling — never logged, never sent to Convex, never embedded in harness prompts, and never included in uploaded screenshots.

---

## 5. Phases

Each phase has an explicit **gate** — don't start the next until it passes.

### Phase 0 — Payment viability (manual, ~1 hour, no code)

Manually buy one cheap item at **Tienda Kay** and one at **Mercado Libre** with the prepaid Visa.
Record: accepted? pre-auth-then-capture? minimum-balance quirks? invoice/receipt format (for `ledger` extraction later).
**Gate:** card works at both. If ML rejects prepaid, decide fallback (e.g. Mercado Pago balance) _before_ building Phase 3.

### Phase 1 — Convex core + dashboard (the brain, no purchasing)

1. Monorepo scaffold; Convex project; schema above; seed script for stores + initial catalog + `store_items` mappings (do the catalog entry session together — it's the fuel for everything).
2. Queries/mutations: current stock (sum of events), `logEvent`, cart CRUD, approve/cancel, config CRUD, audit event writes. Transition guards for every cart/job state.
3. Nightly cron (06:00 UTC = 03:00 ART): reorder scan → grouped proposed carts (pure query logic from design §5, substitutions included; skip items already in an open cart/job).
4. Expiry cron (every 5 min): `awaiting_confirm` past deadline → `expired`; stale `order_summary_screenshot_expires_at` cleanup; `confirming` older than the recovery threshold → `needs_reconciliation`.
5. Next.js dashboard + Clerk (2 users): stock grid with tap targets ("agotado", "queda poco", "+1"), proposed-cart review/edit/approve, ledger view, config editor, job/audit timeline, **reconciliation sweep view (D7)** — walk the catalog, correct counts, writes `reason: "reconciliation"` events.
   **Gate:** a week of real household use — logging feels effortless, nightly proposals look right.

### Phase 1.5 — VPS + remote browser bootstrap

1. Provision an Argentina/Buenos Aires VPS if practical; otherwise choose the nearest reliable VPS and mark the IP-location risk explicitly. Start with at least 2 vCPU / 4 GB RAM; upgrade to 4 vCPU / 8 GB if Chrome or harness runs are unstable.
2. Harden the host: non-root deploy user, firewall, automatic security updates, encrypted secret material, systemd service skeleton, log rotation, and off-box backups for Convex-independent config/secrets.
3. Install Chrome/Chromium, Playwright dependencies, display stack (`Xvfb` or lightweight desktop), and noVNC accessible only through Tailscale or SSH tunnel.
4. Run manual login drills for each Phase 2/3 store through noVNC. Verify persistent profiles survive service restart and VPS reboot.
5. Record IP behavior: Tienda Nube baseline, Mercado Libre login/search/cart baseline, captcha/challenge observations. Only buy a proxy after a repeated, store-specific datacenter-IP problem is observed.
   **Gate:** remote login/captcha recovery works, profiles persist across reboot, and at least the Tienda Nube target can browse/cart from the VPS without abnormal challenges.

### Phase 2 — Worker + StagehandExecutor for Tienda Nube

- **S2.0 Spike (timeboxed, 1–2 days):** VPS Chrome + persistent profile + Stagehand local launch/keepAlive + fixed CDP endpoint. Validate: (a) session survives Stagehand close, worker restart, and VPS reboot (login persists), (b) Playwright MCP can attach to the same CDP endpoint after Stagehand stops, (c) `observe()`-persist → `act(action)` replay works with **zero LLM calls** (measure!), (d) heal path works when we sabotage a selector. If Stagehand local persistence regresses, fall back to worker-launched Chrome + direct Playwright deterministic steps and keep Stagehand for observation/exploration. **This spike is the plan's biggest unknown — do it first.**
- Worker loop (claim/lease/subscribe), browser lifecycle, secrets, screenshot upload, the full confirm handshake (§3), trajectory store.
- Tienda Nube flows: login-check, add-to-cart (prefer `store_items.product_url`/SKU; fall back to search by item name + note), checkout-to-summary, confirm. First run in explore mode, watched over noVNC.
- Run a real weekly purchase end-to-end at Tienda Kay. Then reuse the same **instruction templates** at Pesce + La Centenaria while building fresh per-store cached action objects (the design's TN-transfer hypothesis is about flow shape, not raw selectors — measure how much heals).
  **Gate:** two consecutive unattended-until-confirm-tap purchases at Tienda Kay from the VPS; measured cache-hit ≥ ~90% on run 2+. Record real token cost per run and IP/captcha behavior — this validates or kills the cost model and VPS posture.

### Phase 3 — Mercado Libre (v1 done here)

- New store record + explorer first-run. Expect more bot detection than Tienda Nube because the VPS is not a home residential IP; compensate with AR geolocation, real persistent session, headful browser, weekly cadence, and captcha-pause path. If the VPS IP is repeatedly challenged, configure a sticky Argentine residential/ISP proxy via `proxy_ref` and retest from a fresh, manually logged-in profile.
- ML-specific: buyer flow variations (seller selection, shipping options, Mercado Pago vs card choice at checkout — Phase 0 findings apply).
  **Gate:** one real ML purchase through the full loop. **v1 complete.**

### Phase 4 — HarnessExecutor + routing

- `executor_config` routing (default/explorer/per-store/per-job) resolved at job creation.
- HarnessExecutor per D3/D11 (two-invocation protocol), Playwright MCP config file, strict tool boundary, env-allowlist (no accidental `ANTHROPIC_API_KEY`), JSON schema output parsing, cost/limit logging, and `paused_limit` handling.
- Explorer tier: route a store's _first_ purchase to harness; its transcript seeds a trajectory skeleton (instructions list) that Stagehand explore-mode fills with concrete actions on run 2.
- Re-verify subscription policy and usage-limit behavior at build time; intentionally simulate a limit/429 and verify the job pauses cleanly without leaving a checkout browser waiting.
  **Gate:** same Tienda Nube purchase succeeds via harness path end-to-end; flipping `executor_config` swaps paths with no code change; forced usage-limit failure lands in `paused_limit` and recovers without manual database surgery.

### Phase 5 — Telegram bot + parser tier

- grammY, long-polling, 2-user `chat_id` allowlist. Structured commands `/out`, `/low`, `/add` with fuzzy match (prefix + Levenshtein over `name`+`aliases`; on ambiguity reply with inline-keyboard choices — no AI).
- Notifications: proposed carts (nightly), `awaiting_confirm` (with screenshot + extracted total + Approve/Reject buttons), captcha pings, completions. Approve/confirm callbacks call the same guarded mutations as the dashboard.
- Parser tier: Convex action, Vercel AI SDK `generateObject` (Zod: `{item, delta, confidence}`), model from `ai_config`; low-confidence → bot asks instead of writing. Free text is a fallback when no command matches.
  **Gate:** a week where most logging happens via Telegram without friction.

### Phase 6 — Coto + Carrefour, reconciliation nudges

- Coto adapter (community catalog scrapers only to seed item identifiers if useful; purchases via executor). Then Carrefour/VTEX — strongest bot detection, do last, lean on §11 posture plus the VPS/proxy decision tree.
- Weekly reconciliation _prompt_ (cron → Telegram, Sunday evening) driving the Phase 1 sweep UI.
- Nice-to-haves once stable: monthly spend summary in ledger view; `items_stock` materialization if event sums ever get slow.

---

## 6. Risk register (updated with verified findings)

| Risk                                            | Verified status (Jul 2026)                                                                                                     | Mitigation in plan                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stagehand caching unreliable                    | **Confirmed** — silent server-cache failures ([#1767]), flow-cache not shipped                                                 | D1: own the cache (observe-persist-replay in Convex); S2.0 measures real replay behavior                                                                                         |
| Stagehand session persistence broken            | **Confirmed open** ([#1250]); `storageState()` removed in v3                                                                   | D2: worker-owned Chrome profile; layered fallbacks in S2.0                                                                                                                       |
| Stagehand CDP attach buggy                      | Open issue [#1392]                                                                                                             | Default to Stagehand local launch with fixed CDP port; S2.0 tests whether Playwright MCP can attach to the kept-alive browser; fallback to direct Playwright deterministic steps |
| Claude/agent harness usage limits               | **Real** — Pro/Max usage is shared across Claude, Claude Code, and IDE usage; API returns `429` + `retry-after` on rate limits | D11: harness optional; Stagehand/API path standalone; `paused_limit`; explicit retry/fallback; env-allowlist prevents accidental API billing                                     |
| Payment acceptance                              | Unverified — **Phase 0 exists for this**                                                                                       | Do it first; ML fallback decision gated before Phase 3                                                                                                                           |
| VPS datacenter IP reputation                    | New risk introduced by dropping the home/residential connection                                                                | D12 + Phase 1.5: AR VPS first; no proxy unless challenged; per-store sticky residential/ISP proxy escape hatch; no IP rotation mid-session                                       |
| Bot detection (ML, Carrefour)                   | Higher than original plan because worker is VPS-hosted                                                                         | §11 posture; real profiles; headful browser over noVNC; captcha-pause is a first-class job state; ML/Carrefour gated separately                                                  |
| VPS/provider failure                            | Lower than Pi power/network risk, but still a single worker                                                                    | systemd auto-restart; host hardening; off-box backups; lease expiry re-queues pre-confirm jobs; `confirming` jobs require reconciliation                                         |
| Convex crons UTC-only                           | **Confirmed**                                                                                                                  | D8: fixed UTC offset (ART has no DST)                                                                                                                                            |
| Browser can't wait forever at summary           | (design gap)                                                                                                                   | D10: 30-min confirm deadline, expiry cron, cheap re-run                                                                                                                          |
| Double-purchase after final click               | Critical design gap in prior draft                                                                                             | D13: `confirming` before final click; unknown outcome → `needs_reconciliation`; never auto-click confirm twice                                                                   |
| Wrong item/substitution/fee bought              | Total-only approval is insufficient                                                                                            | D14: extracted summary lines, substitutions, delivery, fees, diff policy, explicit override for material differences                                                             |
| Stock drift after delivery                      | Online order placed ≠ goods received                                                                                           | Ledger `placed` first; stock only changes on `received`/`reconciliation`; Phase 1 reconciliation sweep ships early                                                               |
| PII/payment leakage via screenshots/transcripts | Checkout pages can show address, phone, partial card, order details                                                            | Redact screenshots locally; short-lived storage; harness secret boundary; card/proxy/store secrets never enter Convex or model prompts                                           |

---

## 7. Build-order summary

```
P0 payment test ──► P1 Convex+dashboard ──► P1.5 VPS/browser ──► S2.0 spike ──► P2 Stagehand+TiendaNube
                                                                                      │
                                                                      v1 DONE ◄── P3 MercadoLibre
                                                                                      │
                                                      P4 Harness+routing ──► P5 Telegram+parser ──► P6 Coto/Carrefour
```

First coding session: monorepo scaffold + Convex schema + seed script (Phase 1, steps 1–2).
