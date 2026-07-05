import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob([
  "./**/*.{js,ts}",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const TOKEN = "test-worker-token-0123456789";

beforeEach(() => {
  vi.stubEnv("WORKER_TOKEN", TOKEN);
});

async function seedItems(
  t: ReturnType<typeof convexTest>,
  names: Array<{ name: string; aliases?: string[]; stock?: number }>,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ids = [];
    for (const spec of names) {
      const id = await ctx.db.insert("items", {
        name: spec.name,
        aliases: spec.aliases ?? [],
        category: "pantry",
        unit: "unit",
        reorder_point: 1,
        reorder_to: 3,
        substitute_item_ids: [],
        active: true,
        created_at: now,
        updated_at: now,
      });
      if (spec.stock) {
        await ctx.db.insert("stock_events", {
          item_id: id,
          delta: spec.stock,
          reason: "reconciliation",
          created_at: now,
        });
      }
      ids.push(id);
    }
    return ids;
  });
}

describe("bot stock logging", () => {
  test("ambiguous name returns candidates instead of writing", async () => {
    const t = convexTest(schema, modules);
    await seedItems(t, [{ name: "Milk whole" }, { name: "Milk skim" }]);
    const result = await t.mutation(api.bot.logStock, {
      botToken: TOKEN,
      itemSearch: "milk",
      delta: 1,
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
    const events = await t.run((ctx) => ctx.db.query("stock_events").collect());
    expect(events).toHaveLength(0);
  });

  test("an exact name match beats fuzzy candidates", async () => {
    const t = convexTest(schema, modules);
    await seedItems(t, [{ name: "Milk" }, { name: "Milk skim" }]);
    const result = await t.mutation(api.bot.logStock, {
      botToken: TOKEN,
      itemSearch: "milk",
      delta: 2,
    });
    expect(result.kind).toBe("logged");
    if (result.kind === "logged") {
      expect(result.row.name).toBe("Milk");
      expect(result.row.currentStock).toBe(2);
    }
  });

  test("itemId bypasses the name search entirely", async () => {
    const t = convexTest(schema, modules);
    const [whole] = await seedItems(t, [
      { name: "Milk whole", stock: 1 },
      { name: "Milk skim" },
    ]);
    const result = await t.mutation(api.bot.logStock, {
      botToken: TOKEN,
      itemSearch: "milk",
      itemId: whole,
      delta: -1,
    });
    expect(result.kind).toBe("logged");
    if (result.kind === "logged") {
      expect(result.row.currentStock).toBe(0);
    }
  });

  test("reconcileStock writes the delta between actual and current", async () => {
    const t = convexTest(schema, modules);
    await seedItems(t, [{ name: "Coffee", stock: 2, aliases: ["cafe"] }]);
    const result = await t.mutation(api.bot.reconcileStock, {
      botToken: TOKEN,
      itemSearch: "cafe",
      actualCount: 5,
    });
    expect(result.kind).toBe("logged");
    if (result.kind === "logged") {
      expect(result.row.currentStock).toBe(5);
    }
    const events = await t.run((ctx) => ctx.db.query("stock_events").collect());
    expect(events.map((event) => event.delta)).toEqual([2, 3]);
  });

  test("rejects a bad bot token", async () => {
    const t = convexTest(schema, modules);
    await seedItems(t, [{ name: "Milk" }]);
    await expect(
      t.mutation(api.bot.logStock, {
        botToken: "wrong-token",
        itemSearch: "milk",
        delta: 1,
      }),
    ).rejects.toThrow(/Invalid bot token/);
  });
});
