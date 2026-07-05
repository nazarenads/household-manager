import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

export const current = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const items = await ctx.db
      .query("items")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const rows = await Promise.all(
      items.map(async (item) => {
        const events = await ctx.db
          .query("stock_events")
          .withIndex("by_item", (q) => q.eq("item_id", item._id))
          .collect();
        const currentStock = events.reduce(
          (sum, event) => sum + event.delta,
          0,
        );
        return { item, currentStock };
      }),
    );
    return rows.sort((a, b) => a.item.name.localeCompare(b.item.name));
  },
});

export const logEvent = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await ctx.db.insert("stock_events", {
      ...args,
      source_user: args.source_user ?? user,
      created_at: Date.now(),
    });
  },
});

export const reconcile = mutation({
  args: {
    item_id: v.id("items"),
    actual_count: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const events = await ctx.db
      .query("stock_events")
      .withIndex("by_item", (q) => q.eq("item_id", args.item_id))
      .collect();
    const currentStock = events.reduce((sum, event) => sum + event.delta, 0);
    const delta = args.actual_count - currentStock;
    if (delta === 0) return null;
    return await ctx.db.insert("stock_events", {
      item_id: args.item_id,
      delta,
      reason: "reconciliation",
      source_user: user,
      ...(args.note ? { note: args.note } : {}),
      created_at: Date.now(),
    });
  },
});
