import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

export const list = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    if (args.includeInactive) {
      return await ctx.db.query("items").collect();
    }
    return await ctx.db
      .query("items")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
  },
});

export const upsert = mutation({
  args: {
    id: v.optional(v.id("items")),
    name: v.string(),
    aliases: v.array(v.string()),
    category: v.string(),
    unit: v.string(),
    reorder_point: v.number(),
    reorder_to: v.number(),
    preferred_store_id: v.optional(v.id("stores")),
    substitute_item_ids: v.array(v.id("items")),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const now = Date.now();
    const { id, ...doc } = args;
    if (id) {
      await ctx.db.patch(id, { ...doc, updated_at: now });
      return id;
    }
    return await ctx.db.insert("items", {
      ...doc,
      created_at: now,
      updated_at: now,
    });
  },
});
