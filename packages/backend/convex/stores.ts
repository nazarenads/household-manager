import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUser, requireWorkerToken } from "./lib/auth";

// Admin edits from the CLI (internal functions bypass Clerk), e.g.:
//   npx convex run stores:updateByLoginRef '{"loginRef":"tienda-kay","domain":"tiendakay.com.ar"}'
export const updateByLoginRef = internalMutation({
  args: {
    loginRef: v.string(),
    domain: v.optional(v.string()),
    executorOverride: v.optional(
      v.union(v.literal("stagehand"), v.literal("harness")),
    ),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const store = await ctx.db
      .query("stores")
      .filter((q) => q.eq(q.field("login_ref"), args.loginRef))
      .unique();
    if (!store) throw new Error(`No store with login_ref "${args.loginRef}"`);
    await ctx.db.patch(store._id, {
      ...(args.domain !== undefined ? { domain: args.domain } : {}),
      ...(args.executorOverride !== undefined
        ? { executor_override: args.executorOverride }
        : {}),
      ...(args.active !== undefined ? { active: args.active } : {}),
      updated_at: Date.now(),
    });
    return { storeId: store._id, name: store.name };
  },
});

export const list = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    if (args.includeInactive) {
      return await ctx.db.query("stores").collect();
    }
    return await ctx.db
      .query("stores")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
  },
});

// Lets the worker CLIs (login drill, spike) resolve a human-friendly
// login_ref/name to the store _id — the key that persistent browser
// profiles are stored under.
export const listForWorker = query({
  args: { workerToken: v.string() },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const stores = await ctx.db
      .query("stores")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return stores.map((store) => ({
      _id: store._id,
      name: store.name,
      domain: store.domain,
      login_ref: store.login_ref,
    }));
  },
});

export const upsert = mutation({
  args: {
    id: v.optional(v.id("stores")),
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
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const now = Date.now();
    const { id, ...doc } = args;
    if (id) {
      await ctx.db.patch(id, { ...doc, updated_at: now });
      return id;
    }
    return await ctx.db.insert("stores", {
      ...doc,
      created_at: now,
      updated_at: now,
    });
  },
});

export const upsertStoreItem = mutation({
  args: {
    id: v.optional(v.id("store_items")),
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
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const now = Date.now();
    const { id, ...doc } = args;
    if (id) {
      await ctx.db.patch(id, { ...doc, updated_at: now });
      return id;
    }
    return await ctx.db.insert("store_items", {
      ...doc,
      created_at: now,
      updated_at: now,
    });
  },
});
