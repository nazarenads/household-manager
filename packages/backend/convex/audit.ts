import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const [stockEvents, cartEvents, jobEvents] = await Promise.all([
      ctx.db.query("stock_events").order("desc").take(limit),
      ctx.db.query("cart_events").order("desc").take(limit),
      ctx.db.query("job_events").order("desc").take(limit),
    ]);

    const stockRows = await Promise.all(
      stockEvents.map(async (event) => {
        const item = await ctx.db.get(event.item_id);
        return {
          type: "stock" as const,
          _id: event._id,
          created_at: event.created_at,
          actor: event.source_user ?? "unknown",
          title: item?.name ?? "Unknown item",
          detail: `${event.delta > 0 ? "+" : ""}${event.delta} (${event.reason})`,
          note: event.note,
        };
      }),
    );

    const cartRows = await Promise.all(
      cartEvents.map(async (event) => {
        const cart = await ctx.db.get(event.cart_id);
        const store = cart ? await ctx.db.get(cart.store_id) : null;
        return {
          type: "cart" as const,
          _id: event._id,
          created_at: event.created_at,
          actor: event.actor,
          title: store?.name ?? "Cart",
          detail: `${event.from_status ?? "created"} -> ${event.to_status}`,
          note: event.note,
        };
      }),
    );

    const jobRows = await Promise.all(
      jobEvents.map(async (event) => {
        const job = await ctx.db.get(event.job_id);
        const store = job ? await ctx.db.get(job.store_id) : null;
        return {
          type: "job" as const,
          _id: event._id,
          created_at: event.created_at,
          actor: event.actor,
          title: store?.name ?? "Purchase job",
          detail: `${event.from_status ?? "created"} -> ${event.to_status}`,
          note: event.note,
        };
      }),
    );

    return [...stockRows, ...cartRows, ...jobRows]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
  },
});
