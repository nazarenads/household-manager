import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
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

/**
 * CLI admin: deactivate an item (by exact name) together with its
 * store_items. Deactivation, not deletion — carts/events may reference it.
 *   npx convex run items:deactivateFromCli '{"name":"Coffee"}'
 */
export const deactivateFromCli = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const items = await ctx.db.query("items").collect();
    const item = items.find(
      (doc) => doc.name.toLowerCase() === args.name.toLowerCase(),
    );
    if (!item) throw new ConvexError(`No item named "${args.name}"`);
    const now = Date.now();
    await ctx.db.patch(item._id, { active: false, updated_at: now });
    const mappings = await ctx.db
      .query("store_items")
      .withIndex("by_item_store", (q) => q.eq("item_id", item._id))
      .collect();
    for (const mapping of mappings) {
      await ctx.db.patch(mapping._id, { active: false, updated_at: now });
    }
    return { item: item.name, deactivatedMappings: mappings.length };
  },
});

/**
 * CLI admin: bulk-create catalog items with their store mapping in one call.
 * Used for catalog seeding sessions.
 */
export const seedFromCli = internalMutation({
  args: {
    // Omit for items whose store does not exist yet (stock-trackable only;
    // the reorder cron skips items without a preferred store).
    store_login_ref: v.optional(v.string()),
    items: v.array(
      v.object({
        name: v.string(),
        aliases: v.array(v.string()),
        category: v.string(),
        unit: v.string(),
        reorder_point: v.number(),
        reorder_to: v.number(),
        // Set to record what is at home right now (writes a reconciliation
        // stock event) so seeding does not instantly propose everything.
        initial_stock: v.optional(v.number()),
        store_item_name: v.optional(v.string()),
        product_url: v.optional(v.string()),
        search_terms: v.optional(v.array(v.string())),
        last_seen_price: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const store = args.store_login_ref
      ? (await ctx.db.query("stores").collect()).find(
          (doc) => doc.login_ref === args.store_login_ref,
        )
      : undefined;
    if (args.store_login_ref && !store) {
      throw new ConvexError(`No store with login_ref "${args.store_login_ref}"`);
    }
    const existing = await ctx.db.query("items").collect();
    const now = Date.now();
    const created: string[] = [];
    const skipped: string[] = [];
    for (const entry of args.items) {
      if (
        existing.some(
          (doc) => doc.name.toLowerCase() === entry.name.toLowerCase(),
        )
      ) {
        skipped.push(entry.name);
        continue;
      }
      const itemId = await ctx.db.insert("items", {
        name: entry.name,
        aliases: entry.aliases,
        category: entry.category,
        unit: entry.unit,
        reorder_point: entry.reorder_point,
        reorder_to: entry.reorder_to,
        ...(store ? { preferred_store_id: store._id } : {}),
        substitute_item_ids: [],
        active: true,
        created_at: now,
        updated_at: now,
      });
      if (store) {
        await ctx.db.insert("store_items", {
          item_id: itemId,
          store_id: store._id,
          name: entry.store_item_name ?? entry.name,
          ...(entry.product_url ? { product_url: entry.product_url } : {}),
          search_terms: entry.search_terms ?? [],
          ...(entry.last_seen_price !== undefined
            ? { last_seen_price: entry.last_seen_price }
            : {}),
          active: true,
          created_at: now,
          updated_at: now,
        });
      }
      if (entry.initial_stock !== undefined && entry.initial_stock > 0) {
        await ctx.db.insert("stock_events", {
          item_id: itemId,
          delta: entry.initial_stock,
          reason: "reconciliation",
          source_user: "admin-cli",
          note: "Initial stock at seeding",
          created_at: now,
        });
      }
      created.push(entry.name);
    }
    return { created, skipped };
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
