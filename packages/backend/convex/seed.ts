import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireWorkerToken } from "./lib/auth";

export const defaults = mutation({
  args: { workerToken: v.string() },
  handler: async (ctx, args) => {
    if (process.env.WORKER_TOKEN) {
      requireWorkerToken(args);
    } else if (process.env.CLERK_JWT_ISSUER_DOMAIN) {
      // Deployed without a worker token: refuse rather than allow anyone
      // holding the Convex URL to seed the database.
      throw new ConvexError("WORKER_TOKEN must be configured before seeding");
    }

    const executorConfig = await ctx.db.query("executor_config").first();
    if (!executorConfig) {
      await ctx.db.insert("executor_config", {
        default_executor: "stagehand",
        explorer_executor: "stagehand",
        harness_cli: "claude-code",
        stagehand_model: "anthropic/claude-haiku-4-5",
        vps_region: "ar-buenos-aires",
        default_proxy_policy: "if_challenged",
        confirm_timeout_minutes: 30,
      });
    }

    const aiDefaults = [
      {
        tier: "parser" as const,
        provider: "anthropic",
        model: "claude-haiku-4-5",
      },
      {
        tier: "executor" as const,
        provider: "anthropic",
        model: "claude-haiku-4-5",
      },
      {
        tier: "explorer" as const,
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ];

    for (const config of aiDefaults) {
      const existing = await ctx.db
        .query("ai_config")
        .withIndex("by_tier", (q) => q.eq("tier", config.tier))
        .unique();
      if (!existing) {
        await ctx.db.insert("ai_config", config);
      }
    }

    const existingStores = await ctx.db.query("stores").collect();
    if (existingStores.length > 0) return;

    const now = Date.now();
    const tiendaKay = await ctx.db.insert("stores", {
      name: "Tienda Kay",
      platform: "tiendanube",
      domain: "tiendakay.example",
      login_ref: "tienda-kay",
      proxy_policy: "none",
      shipping_preference: "default",
      active: true,
      created_at: now,
      updated_at: now,
    });
    const mercadoLibre = await ctx.db.insert("stores", {
      name: "Mercado Libre",
      platform: "mercadolibre",
      domain: "mercadolibre.com.ar",
      login_ref: "mercado-libre",
      proxy_policy: "if_challenged",
      shipping_preference: "default",
      active: true,
      created_at: now,
      updated_at: now,
    });

    const yerba = await ctx.db.insert("items", {
      name: "Yerba mate",
      aliases: ["yerba", "mate"],
      category: "pantry",
      unit: "pack",
      reorder_point: 1,
      reorder_to: 3,
      preferred_store_id: tiendaKay,
      substitute_item_ids: [],
      active: true,
      created_at: now,
      updated_at: now,
    });
    const detergent = await ctx.db.insert("items", {
      name: "Laundry detergent",
      aliases: ["detergent", "jabon liquido"],
      category: "cleaning",
      unit: "bottle",
      reorder_point: 1,
      reorder_to: 2,
      preferred_store_id: tiendaKay,
      substitute_item_ids: [],
      active: true,
      created_at: now,
      updated_at: now,
    });
    const coffee = await ctx.db.insert("items", {
      name: "Coffee",
      aliases: ["cafe"],
      category: "pantry",
      unit: "bag",
      reorder_point: 1,
      reorder_to: 2,
      preferred_store_id: mercadoLibre,
      substitute_item_ids: [],
      active: true,
      created_at: now,
      updated_at: now,
    });

    await ctx.db.insert("store_items", {
      item_id: yerba,
      store_id: tiendaKay,
      name: "Yerba mate 1kg",
      search_terms: ["yerba mate 1kg"],
      active: true,
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("store_items", {
      item_id: detergent,
      store_id: tiendaKay,
      name: "Laundry detergent 3L",
      search_terms: ["detergent 3L", "jabon liquido"],
      active: true,
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("store_items", {
      item_id: coffee,
      store_id: mercadoLibre,
      name: "Coffee 500g",
      search_terms: ["coffee 500g", "cafe 500g"],
      active: true,
      created_at: now,
      updated_at: now,
    });

    for (const [item_id, delta] of [
      [yerba, 1],
      [detergent, 0],
      [coffee, 2],
    ] as const) {
      if (delta === 0) continue;
      await ctx.db.insert("stock_events", {
        item_id,
        delta,
        reason: "reconciliation",
        source_user: "seed",
        note: "Initial demo stock",
        created_at: now,
      });
    }
  },
});
