import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({
    name: v.string(),
    aliases: v.array(v.string()),
    category: v.string(),
    unit: v.string(),
    reorder_point: v.number(),
    reorder_to: v.number(),
    preferred_store_id: v.optional(v.id("stores")),
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
    login_ref: v.string(),
    proxy_ref: v.optional(v.string()),
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
    claimed_by: v.optional(v.string()),
    lease_expires_at: v.optional(v.number()),
    order_summary_screenshot: v.optional(v.id("_storage")),
    order_summary_screenshot_expires_at: v.optional(v.number()),
    order_summary_total: v.optional(v.number()),
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
    summary_diff: v.optional(v.any()),
    confirm_deadline: v.optional(v.number()),
    confirmed_by: v.optional(v.string()),
    confirmed_at: v.optional(v.number()),
    confirm_started_at: v.optional(v.number()),
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
    actor: v.string(),
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
    store_id: v.id("stores"),
    flow: v.string(),
    steps: v.array(
      v.object({
        instruction: v.string(),
        action: v.any(),
        last_healed_at: v.optional(v.number()),
      }),
    ),
    version: v.number(),
    success_count: v.number(),
    failure_count: v.number(),
    updated_at: v.number(),
  }).index("by_store_flow", ["store_id", "flow"]),

  ai_config: defineTable({
    tier: v.union(
      v.literal("parser"),
      v.literal("executor"),
      v.literal("explorer"),
    ),
    provider: v.string(),
    model: v.string(),
  }).index("by_tier", ["tier"]),

  executor_config: defineTable({
    default_executor: v.union(v.literal("stagehand"), v.literal("harness")),
    explorer_executor: v.union(v.literal("stagehand"), v.literal("harness")),
    harness_cli: v.optional(
      v.union(v.literal("claude-code"), v.literal("codex")),
    ),
    stagehand_model: v.optional(v.string()),
    vps_region: v.string(),
    default_proxy_policy: v.union(
      v.literal("none"),
      v.literal("if_challenged"),
    ),
    confirm_timeout_minutes: v.number(),
  }),
});
