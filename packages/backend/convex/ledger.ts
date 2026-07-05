import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";

export const list = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("placed"),
        v.literal("received"),
        v.literal("adjusted"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const limit = Math.min(Math.max(args.limit ?? 12, 1), 50);
    const rows = args.status
      ? await ctx.db
          .query("ledger")
          .filter((q) => q.eq(q.field("status"), args.status))
          .order("desc")
          .take(limit)
      : await ctx.db.query("ledger").order("desc").take(limit);

    return await Promise.all(
      rows.map(async (entry) => {
        const store = await ctx.db.get(entry.store_id);
        const job = await ctx.db.get(entry.job_id);
        return {
          ...entry,
          store: store
            ? {
                _id: store._id,
                name: store.name,
                platform: store.platform,
              }
            : null,
          job: job
            ? {
                _id: job._id,
                status: job.status,
                cart_id: job.cart_id,
              }
            : null,
        };
      }),
    );
  },
});
