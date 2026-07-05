import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob([
  "./**/*.{js,ts}",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

type SeedItem = {
  name: string;
  stock: number;
  reorderPoint?: number;
  reorderTo?: number;
  substitutes?: Id<"items">[];
  mapped?: boolean;
};

async function seedStore(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("stores", {
      name: "Test Store",
      platform: "tiendanube",
      domain: "test.example",
      login_ref: "test-store",
      proxy_policy: "none",
      shipping_preference: "default",
      active: true,
      created_at: now,
      updated_at: now,
    });
  });
}

async function seedItem(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  spec: SeedItem,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const itemId = await ctx.db.insert("items", {
      name: spec.name,
      aliases: [],
      category: "pantry",
      unit: "unit",
      reorder_point: spec.reorderPoint ?? 1,
      reorder_to: spec.reorderTo ?? 3,
      preferred_store_id: storeId,
      substitute_item_ids: spec.substitutes ?? [],
      active: true,
      created_at: now,
      updated_at: now,
    });
    if (spec.stock !== 0) {
      await ctx.db.insert("stock_events", {
        item_id: itemId,
        delta: spec.stock,
        reason: "reconciliation",
        created_at: now,
      });
    }
    if (spec.mapped !== false) {
      await ctx.db.insert("store_items", {
        item_id: itemId,
        store_id: storeId,
        name: `${spec.name} mapped`,
        search_terms: [spec.name.toLowerCase()],
        active: true,
        created_at: now,
        updated_at: now,
      });
    }
    return itemId;
  });
}

async function proposedCarts(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) =>
    ctx.db
      .query("carts")
      .withIndex("by_status", (q) => q.eq("status", "proposed"))
      .collect(),
  );
}

describe("nightly reorder proposals", () => {
  test("proposes reorder_to minus stock for an item under its point", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seedStore(t);
    const itemId = await seedItem(t, storeId, {
      name: "Yerba",
      stock: 1,
      reorderPoint: 1,
      reorderTo: 3,
    });

    await t.mutation(internal.reorder.createNightlyProposals, {});
    const carts = await proposedCarts(t);
    expect(carts).toHaveLength(1);
    expect(carts[0]!.lines).toEqual([
      expect.objectContaining({ item_id: itemId, qty: 2 }),
    ]);
  });

  test("substitute stock covers the need — no proposal", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seedStore(t);
    const substitute = await seedItem(t, storeId, {
      name: "Yerba brand B",
      stock: 5,
    });
    await seedItem(t, storeId, {
      name: "Yerba",
      stock: 0,
      substitutes: [substitute],
    });

    await t.mutation(internal.reorder.createNightlyProposals, {});
    // Brand B alone is above its own point too, so nothing at all.
    expect(await proposedCarts(t)).toHaveLength(0);
  });

  test("an open cart containing a substitute suppresses the proposal", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seedStore(t);
    const substitute = await seedItem(t, storeId, {
      name: "Yerba brand B",
      stock: 0,
    });
    const itemId = await seedItem(t, storeId, {
      name: "Yerba",
      stock: 0,
      substitutes: [substitute],
    });
    void itemId;
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("carts", {
        store_id: storeId,
        status: "approved",
        lines: [{ item_id: substitute, qty: 3 }],
        created_at: now,
        updated_at: now,
      });
    });

    await t.mutation(internal.reorder.createNightlyProposals, {});
    // The only new proposed cart would be for Yerba; the substitute's open
    // cart means replenishment is already on the way.
    expect(await proposedCarts(t)).toHaveLength(0);
  });

  test("falls back to a mapped substitute when the item has no store mapping", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seedStore(t);
    const substitute = await seedItem(t, storeId, {
      name: "Yerba brand B",
      stock: 0,
      reorderPoint: 0, // don't trigger its own proposal
    });
    await seedItem(t, storeId, {
      name: "Yerba",
      stock: 0,
      substitutes: [substitute],
      mapped: false,
    });

    await t.mutation(internal.reorder.createNightlyProposals, {});
    const carts = await proposedCarts(t);
    expect(carts).toHaveLength(1);
    const substituteLine = carts[0]!.lines.find(
      (line) =>
        line.item_id === substitute && line.note?.includes("Substitute"),
    );
    expect(substituteLine).toBeDefined();
  });
});
