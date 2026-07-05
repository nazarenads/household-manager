import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type ProposalLine = {
  item_id: Id<"items">;
  store_item_id?: Id<"store_items">;
  qty: number;
  expected_unit_price?: number;
  note?: string;
};

const openCartStatuses: Doc<"carts">["status"][] = [
  "proposed",
  "approved",
  "executing",
  "awaiting_confirm",
];

async function currentStockForItem(ctx: MutationCtx, itemId: Id<"items">) {
  const events = await ctx.db
    .query("stock_events")
    .withIndex("by_item", (q) => q.eq("item_id", itemId))
    .collect();
  return events.reduce((sum, event) => sum + event.delta, 0);
}

async function itemIsAlreadyOpen(
  ctx: MutationCtx,
  storeId: Id<"stores">,
  itemId: Id<"items">,
) {
  for (const status of openCartStatuses) {
    const carts = await ctx.db
      .query("carts")
      .withIndex("by_store_status", (q) =>
        q.eq("store_id", storeId).eq("status", status),
      )
      .collect();
    if (
      carts.some((cart) => cart.lines.some((line) => line.item_id === itemId))
    ) {
      return true;
    }
  }
  return false;
}

async function storeItemForItem(
  ctx: MutationCtx,
  storeId: Id<"stores">,
  itemId: Id<"items">,
) {
  return await ctx.db
    .query("store_items")
    .withIndex("by_item_store", (q) =>
      q.eq("item_id", itemId).eq("store_id", storeId),
    )
    .filter((q) => q.eq(q.field("active"), true))
    .first();
}

async function substituteNote(ctx: MutationCtx, item: Doc<"items">) {
  if (item.substitute_item_ids.length === 0) return undefined;
  const substitutes = await Promise.all(
    item.substitute_item_ids.map((id) => ctx.db.get(id)),
  );
  const names = substitutes
    .filter((substitute): substitute is Doc<"items"> => Boolean(substitute))
    .map((substitute) => substitute.name);
  return names.length > 0 ? `Substitutes: ${names.join(", ")}` : undefined;
}

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
      { storeId: Id<"stores">; lines: ProposalLine[] }
    >();

    for (const item of items) {
      if (!item.preferred_store_id) continue;
      const currentStock = await currentStockForItem(ctx, item._id);
      if (currentStock > item.reorder_point) continue;
      if (await itemIsAlreadyOpen(ctx, item.preferred_store_id, item._id)) {
        continue;
      }

      const storeItem = await storeItemForItem(
        ctx,
        item.preferred_store_id,
        item._id,
      );
      const note = await substituteNote(ctx, item);
      const qty = Math.max(item.reorder_to - currentStock, 1);
      const entry = proposedByStore.get(item.preferred_store_id) ?? {
        storeId: item.preferred_store_id,
        lines: [],
      };
      entry.lines.push({
        item_id: item._id,
        ...(storeItem ? { store_item_id: storeItem._id } : {}),
        qty,
        ...(storeItem?.last_seen_price
          ? { expected_unit_price: storeItem.last_seen_price }
          : {}),
        ...(note ? { note } : {}),
      });
      proposedByStore.set(item.preferred_store_id, entry);
    }

    for (const proposal of proposedByStore.values()) {
      if (proposal.lines.length === 0) continue;
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
