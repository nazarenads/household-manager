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

async function openCartItemIds(ctx: MutationCtx) {
  const ids = new Set<Id<"items">>();
  for (const status of openCartStatuses) {
    const carts = await ctx.db
      .query("carts")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    for (const cart of carts) {
      for (const line of cart.lines) {
        ids.add(line.item_id);
      }
    }
  }
  return ids;
}

async function stockFor(
  ctx: MutationCtx,
  itemId: Id<"items">,
  cache: Map<Id<"items">, number>,
) {
  const cached = cache.get(itemId);
  if (cached !== undefined) return cached;
  const events = await ctx.db
    .query("stock_events")
    .withIndex("by_item", (q) => q.eq("item_id", itemId))
    .collect();
  const total = events.reduce((sum, event) => sum + event.delta, 0);
  cache.set(itemId, total);
  return total;
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

export const createNightlyProposals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const items = await ctx.db
      .query("items")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const openItemIds = await openCartItemIds(ctx);
    const stockCache = new Map<Id<"items">, number>();
    const proposedByStore = new Map<
      string,
      { storeId: Id<"stores">; lines: ProposalLine[] }
    >();

    for (const item of items) {
      if (!item.preferred_store_id) continue;

      const substitutes = (
        await Promise.all(item.substitute_item_ids.map((id) => ctx.db.get(id)))
      ).filter(
        (substitute): substitute is Doc<"items"> =>
          Boolean(substitute) && substitute!.active,
      );

      // Substitute stock covers the need; an open cart for the item or a
      // substitute means replenishment is already on the way.
      const ownStock = await stockFor(ctx, item._id, stockCache);
      let effectiveStock = ownStock;
      for (const substitute of substitutes) {
        effectiveStock += await stockFor(ctx, substitute._id, stockCache);
      }
      if (effectiveStock > item.reorder_point) continue;
      if (
        openItemIds.has(item._id) ||
        substitutes.some((substitute) => openItemIds.has(substitute._id))
      ) {
        continue;
      }

      let lineItem: Doc<"items"> = item;
      let storeItem = await storeItemForItem(
        ctx,
        item.preferred_store_id,
        item._id,
      );
      let note =
        substitutes.length > 0
          ? `Substitutes: ${substitutes.map((s) => s.name).join(", ")}`
          : undefined;
      if (!storeItem) {
        for (const substitute of substitutes) {
          const substituteStoreItem = await storeItemForItem(
            ctx,
            item.preferred_store_id,
            substitute._id,
          );
          if (substituteStoreItem) {
            lineItem = substitute;
            storeItem = substituteStoreItem;
            note = `Substitute for ${item.name} (no store mapping)`;
            break;
          }
        }
      }

      const qty = Math.max(item.reorder_to - ownStock, 1);
      const entry = proposedByStore.get(item.preferred_store_id) ?? {
        storeId: item.preferred_store_id,
        lines: [],
      };
      entry.lines.push({
        item_id: lineItem._id,
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
