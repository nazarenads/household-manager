import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUser, requireWorkerToken } from "./lib/auth";

export const getForStoreFlow = query({
  args: { store_id: v.id("stores"), flow: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db
      .query("trajectories")
      .withIndex("by_store_flow", (q) =>
        q.eq("store_id", args.store_id).eq("flow", args.flow),
      )
      .unique();
  },
});

export const save = mutation({
  args: {
    workerToken: v.string(),
    store_id: v.id("stores"),
    flow: v.string(),
    steps: v.array(
      v.object({
        instruction: v.string(),
        action: v.any(),
        last_healed_at: v.optional(v.number()),
      }),
    ),
    version: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const existing = await ctx.db
      .query("trajectories")
      .withIndex("by_store_flow", (q) =>
        q.eq("store_id", args.store_id).eq("flow", args.flow),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        steps: args.steps,
        version: args.version ?? existing.version + 1,
        updated_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("trajectories", {
      store_id: args.store_id,
      flow: args.flow,
      steps: args.steps,
      version: args.version ?? 1,
      success_count: 0,
      failure_count: 0,
      updated_at: now,
    });
  },
});

export const recordOutcome = mutation({
  args: {
    workerToken: v.string(),
    trajectory_id: v.id("trajectories"),
    success: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const trajectory = await ctx.db.get(args.trajectory_id);
    if (!trajectory) throw new ConvexError("Trajectory not found");
    await ctx.db.patch(trajectory._id, {
      success_count: trajectory.success_count + (args.success ? 1 : 0),
      failure_count: trajectory.failure_count + (args.success ? 0 : 1),
      updated_at: Date.now(),
    });
  },
});
