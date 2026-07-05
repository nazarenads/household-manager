import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { resolveExecutor } from "./lib/executors";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob([
  "./**/*.{js,ts}",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

async function seed(
  t: ReturnType<typeof convexTest>,
  options: {
    executorOverride?: "stagehand" | "harness";
    explorerExecutor?: "stagehand" | "harness";
    withTrajectory?: boolean;
    withConfig?: boolean;
  } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const storeId = await ctx.db.insert("stores", {
      name: "Test Store",
      platform: "tiendanube",
      domain: "test.example",
      login_ref: "test-store",
      proxy_policy: "none",
      shipping_preference: "default",
      ...(options.executorOverride
        ? { executor_override: options.executorOverride }
        : {}),
      active: true,
      created_at: now,
      updated_at: now,
    });
    if (options.withConfig !== false) {
      await ctx.db.insert("executor_config", {
        default_executor: "stagehand",
        explorer_executor: options.explorerExecutor ?? "harness",
        vps_region: "ar",
        default_proxy_policy: "none",
        confirm_timeout_minutes: 30,
      });
    }
    if (options.withTrajectory) {
      await ctx.db.insert("trajectories", {
        store_id: storeId,
        flow: "login",
        steps: [],
        version: 1,
        success_count: 1,
        failure_count: 0,
        updated_at: now,
      });
    }
    return storeId;
  });
}

async function resolve(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  explicit?: "stagehand" | "harness",
) {
  return await t.run(async (ctx) => {
    const store = await ctx.db.get(storeId);
    return await resolveExecutor(ctx as never, store, storeId, explicit);
  });
}

describe("resolveExecutor routing", () => {
  test("explicit choice wins over everything", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seed(t, {
      executorOverride: "harness",
      withTrajectory: true,
    });
    expect(await resolve(t, storeId, "stagehand")).toBe("stagehand");
  });

  test("store override beats explorer tier", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seed(t, { executorOverride: "stagehand" });
    // No trajectories → explorer tier would say harness, but override wins.
    expect(await resolve(t, storeId)).toBe("stagehand");
  });

  test("first contact (no trajectories) routes to the explorer executor", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seed(t, { explorerExecutor: "harness" });
    expect(await resolve(t, storeId)).toBe("harness");
  });

  test("known store (has trajectories) uses the default executor", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seed(t, {
      explorerExecutor: "harness",
      withTrajectory: true,
    });
    expect(await resolve(t, storeId)).toBe("stagehand");
  });

  test("falls back to stagehand without any config", async () => {
    const t = convexTest(schema, modules);
    const storeId = await seed(t, { withConfig: false });
    expect(await resolve(t, storeId)).toBe("stagehand");
  });
});
