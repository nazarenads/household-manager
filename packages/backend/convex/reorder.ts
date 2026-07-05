import { internalMutation } from "./_generated/server";

export const createNightlyProposals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const items = await ctx.db
      .query("items")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const proposedByStore = new Map<
      string,
      { storeId: (typeof items)[number]["preferred_store_id"]; lines: any[] }
    >();

    for (const item of items) {
      if (!item.preferred_store_id) continue;
      const events = await ctx.db
        .query("stock_events")
        .withIndex("by_item", (q) => q.eq("item_id", item._id))
        .collect();
      const currentStock = events.reduce((sum, event) => sum + event.delta, 0);
      if (currentStock > item.reorder_point) continue;

      const openCarts = await ctx.db
        .query("carts")
        .withIndex("by_store_status", (q) =>
          q.eq("store_id", item.preferred_store_id!).eq("status", "proposed"),
        )
        .collect();
      const alreadyOpen = openCarts.some((cart) =>
        cart.lines.some((line) => line.item_id === item._id),
      );
      if (alreadyOpen) continue;

      const qty = Math.max(item.reorder_to - currentStock, 1);
      const key = item.preferred_store_id;
      const entry = proposedByStore.get(key) ?? {
        storeId: item.preferred_store_id,
        lines: [],
      };
      entry.lines.push({ item_id: item._id, qty });
      proposedByStore.set(key, entry);
    }

    for (const proposal of proposedByStore.values()) {
      if (!proposal.storeId || proposal.lines.length === 0) continue;
      const cartId = await ctx.db.insert("carts", {
        store_id: proposal.storeId,
        status: "proposed",
        lines: proposal.lines,
        created_at: now,
        updated_at: now,
      });
      await ctx.db.insert("cart_events", {
        cart_id: cartId,
        to_status: "proposed",
        actor: "cron",
        note: "Nightly reorder proposal",
        created_at: now,
      });
    }
  },
});
