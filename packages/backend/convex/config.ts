import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

export const getAiConfigForTier = internalQuery({
  args: {
    tier: v.union(
      v.literal("parser"),
      v.literal("executor"),
      v.literal("explorer"),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ai_config")
      .withIndex("by_tier", (q) => q.eq("tier", args.tier))
      .unique();
  },
});

export const getExecutorConfig = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const configs = await ctx.db.query("executor_config").collect();
    return configs[0] ?? null;
  },
});

export const setExecutorConfig = mutation({
  args: {
    id: v.optional(v.id("executor_config")),
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
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db.query("executor_config").collect();
    if (!args.id && existing.length > 0) {
      throw new ConvexError("Executor config already exists");
    }
    const { id, ...doc } = args;
    if (id) {
      await ctx.db.replace(id, doc);
      return id;
    }
    return await ctx.db.insert("executor_config", doc);
  },
});

export const listAiConfig = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.db.query("ai_config").collect();
  },
});

export const setAiConfig = mutation({
  args: {
    tier: v.union(
      v.literal("parser"),
      v.literal("executor"),
      v.literal("explorer"),
    ),
    provider: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db
      .query("ai_config")
      .withIndex("by_tier", (q) => q.eq("tier", args.tier))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        provider: args.provider,
        model: args.model,
      });
      return existing._id;
    }
    return await ctx.db.insert("ai_config", args);
  },
});
