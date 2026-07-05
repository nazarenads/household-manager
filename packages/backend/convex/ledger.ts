import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
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

export const markReceived = mutation({
  args: {
    id: v.id("ledger"),
    receipt_ref: v.optional(v.string()),
    received_items: v.array(
      v.object({
        item_id: v.id("items"),
        qty: v.number(),
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const entry = await ctx.db.get(args.id);
    if (!entry) throw new ConvexError("Ledger entry not found");
    if (entry.status === "received") return entry._id;
    if (entry.status !== "placed") {
      throw new ConvexError("Only placed orders can be marked received");
    }

    const now = Date.now();
    await ctx.db.patch(entry._id, {
      status: "received",
      ...(args.receipt_ref ? { receipt_ref: args.receipt_ref } : {}),
      received_at: now,
      updated_at: now,
    });

    for (const item of args.received_items) {
      if (item.qty <= 0) continue;
      await ctx.db.insert("stock_events", {
        item_id: item.item_id,
        delta: item.qty,
        reason: "received",
        source_user: actor,
        job_id: entry.job_id,
        note: item.note ?? `Received from ledger ${entry._id}`,
        created_at: now,
      });
    }

    return entry._id;
  },
});
