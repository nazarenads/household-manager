import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

type T = TestConvex<typeof schema>;

const modules = import.meta.glob([
  "./**/*.{js,ts}",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const WORKER_TOKEN = "test-worker-token-0123456789";
const WORKER_ID = "vps-test";

beforeEach(() => {
  vi.stubEnv("WORKER_TOKEN", WORKER_TOKEN);
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "");
  vi.stubEnv("CLERK_ALLOWED_SUBJECTS", "");
});

type Seeded = {
  storeId: Id<"stores">;
  itemA: Id<"items">;
  itemB: Id<"items">;
  cartId: Id<"carts">;
};

async function seed(t: T): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("executor_config", {
      default_executor: "stagehand",
      explorer_executor: "stagehand",
      vps_region: "ar",
      default_proxy_policy: "none",
      confirm_timeout_minutes: 30,
    });
    const storeId = await ctx.db.insert("stores", {
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
    const item = (name: string) => ({
      name,
      aliases: [],
      category: "pantry",
      unit: "unit",
      reorder_point: 1,
      reorder_to: 2,
      preferred_store_id: storeId,
      substitute_item_ids: [],
      active: true,
      created_at: now,
      updated_at: now,
    });
    const itemA = await ctx.db.insert("items", item("Yerba"));
    const itemB = await ctx.db.insert("items", item("Coffee"));
    const cartId = await ctx.db.insert("carts", {
      store_id: storeId,
      status: "approved",
      lines: [
        { item_id: itemA, qty: 2, expected_unit_price: 100 },
        { item_id: itemB, qty: 1 },
      ],
      created_at: now,
      updated_at: now,
    });
    return { storeId, itemA, itemB, cartId };
  });
}

function summaryLines(seeded: Seeded, overrides: { qtyA?: number } = {}) {
  return [
    {
      item_id: seeded.itemA,
      name: "Yerba",
      qty: overrides.qtyA ?? 2,
      unit_price: 100,
      status: "expected" as const,
    },
    {
      item_id: seeded.itemB,
      name: "Coffee",
      qty: 1,
      status: "expected" as const,
    },
  ];
}

async function queueAndClaim(t: T, seeded: Seeded) {
  const jobId = await t.mutation(api.carts.queueApproved, {
    cart_id: seeded.cartId,
  });
  const claimed = await t.mutation(api.jobs.claim, {
    workerToken: WORKER_TOKEN,
    job_id: jobId,
    worker_id: WORKER_ID,
  });
  expect(claimed?.status).toBe("running");
  return jobId;
}

describe("confirm handshake", () => {
  test("full happy path: queue → claim → summary → confirm → confirming → done", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);

    await t.mutation(api.jobs.reachedSummary, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      order_summary_total: 300,
      order_summary_currency: "ARS",
      summary_line_items: summaryLines(seeded),
    });
    const awaiting = await t.run((ctx) => ctx.db.get(jobId));
    expect(awaiting?.status).toBe("awaiting_confirm");
    expect(
      (awaiting?.summary_diff as { withinPolicy: boolean }).withinPolicy,
    ).toBe(true);
    expect(awaiting?.confirm_deadline).toBeGreaterThan(Date.now());

    await t.mutation(api.jobs.confirm, { job_id: jobId });
    await t.mutation(api.jobs.startConfirming, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
    });
    await t.mutation(api.jobs.complete, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      order_ref: "ORDER-1",
      total: 300,
      currency: "ARS",
      line_items: [{ name: "Yerba", qty: 2, price: 100 }],
    });

    const done = await t.run((ctx) => ctx.db.get(jobId));
    expect(done?.status).toBe("done");
    const cart = await t.run((ctx) => ctx.db.get(seeded.cartId));
    expect(cart?.status).toBe("completed");
    const ledger = await t.run((ctx) =>
      ctx.db
        .query("ledger")
        .withIndex("by_job", (q) => q.eq("job_id", jobId))
        .first(),
    );
    expect(ledger?.total).toBe(300);
  });

  test("strict diff policy: qty mismatch blocks confirm unless overridden", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);

    await t.mutation(api.jobs.reachedSummary, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      order_summary_total: 400,
      order_summary_currency: "ARS",
      summary_line_items: summaryLines(seeded, { qtyA: 3 }),
    });
    const job = await t.run((ctx) => ctx.db.get(jobId));
    const diff = job?.summary_diff as {
      withinPolicy: boolean;
      issues: Array<{ type: string }>;
    };
    expect(diff.withinPolicy).toBe(false);
    expect(diff.issues.map((issue) => issue.type)).toContain("qty_mismatch");

    await expect(
      t.mutation(api.jobs.confirm, { job_id: jobId }),
    ).rejects.toThrow(/override required/);
    await t.mutation(api.jobs.confirm, {
      job_id: jobId,
      override_summary_diff: true,
    });
    const confirmed = await t.run((ctx) => ctx.db.get(jobId));
    expect(confirmed?.status).toBe("confirmed");
  });

  test("a cart cannot be queued twice", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    await t.mutation(api.carts.queueApproved, { cart_id: seeded.cartId });
    // Queueing moves the cart to executing, so a second queue is rejected.
    await expect(
      t.mutation(api.carts.queueApproved, { cart_id: seeded.cartId }),
    ).rejects.toThrow(/Only approved carts/);
    const jobs = await t.run((ctx) =>
      ctx.db
        .query("purchase_jobs")
        .withIndex("by_cart", (q) => q.eq("cart_id", seeded.cartId))
        .collect(),
    );
    expect(jobs).toHaveLength(1);
  });
});

describe("delivery-date gate", () => {
  const OPTIONS = ["Lunes 13/07", "Martes 14/07", "Miércoles 15/07"];

  test("human choice: options published, Telegram pick resumes the job", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);

    await t.mutation(api.jobs.awaitDeliveryChoice, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      delivery_options: OPTIONS,
    });
    const awaiting = await t.run((ctx) => ctx.db.get(jobId));
    expect(awaiting?.status).toBe("awaiting_delivery_choice");
    expect(awaiting?.delivery_options).toEqual(OPTIONS);
    expect(awaiting?.delivery_choice_deadline).toBeGreaterThan(Date.now());

    const chosen = await t.mutation(api.bot.chooseDelivery, {
      botToken: WORKER_TOKEN,
      jobId,
      optionIndex: 1,
      sourceUser: "naza",
    });
    expect(chosen).toBe("Martes 14/07");
    const resumed = await t.run((ctx) => ctx.db.get(jobId));
    expect(resumed?.status).toBe("running");
    expect(resumed?.chosen_delivery_option).toBe("Martes 14/07");
    expect(resumed?.delivery_chosen_by).toBe("naza");
    expect(resumed?.lease_expires_at).toBeGreaterThan(Date.now());
  });

  test("worker fallback resumes with the earliest; no-op if a human already chose", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);
    await t.mutation(api.jobs.awaitDeliveryChoice, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      delivery_options: OPTIONS,
    });

    await t.mutation(api.jobs.resumeDeliveryDefault, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      option: OPTIONS[0]!,
    });
    const resumed = await t.run((ctx) => ctx.db.get(jobId));
    expect(resumed?.status).toBe("running");
    expect(resumed?.chosen_delivery_option).toBe(OPTIONS[0]);
    expect(resumed?.delivery_chosen_by).toBe(WORKER_ID);

    // A late fallback against an already-resumed job must not throw or clobber.
    await t.mutation(api.jobs.resumeDeliveryDefault, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      option: OPTIONS[2]!,
    });
    const after = await t.run((ctx) => ctx.db.get(jobId));
    expect(after?.chosen_delivery_option).toBe(OPTIONS[0]);
  });

  test("rejects an option that was never offered", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);
    await t.mutation(api.jobs.awaitDeliveryChoice, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      delivery_options: OPTIONS,
    });
    await expect(
      t.mutation(api.bot.chooseDelivery, {
        botToken: WORKER_TOKEN,
        jobId,
        optionIndex: 99,
      }),
    ).rejects.toThrow(/Unknown delivery option/);
  });

  test("expireStale requeues a gate abandoned past its deadline", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);
    await t.mutation(api.jobs.awaitDeliveryChoice, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      delivery_options: OPTIONS,
    });
    await t.run((ctx) =>
      ctx.db.patch(jobId, { delivery_choice_deadline: Date.now() - 1000 }),
    );

    await t.mutation(internal.jobs.expireStale, {});
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("queued");
    expect(job?.claimed_by).toBeUndefined();
    expect(job?.delivery_options).toBeUndefined();
  });
});

describe("expireStale cron", () => {
  test("requeues a running job whose lease lapsed", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);
    await t.run((ctx) =>
      ctx.db.patch(jobId, { lease_expires_at: Date.now() - 1000 }),
    );

    await t.mutation(internal.jobs.expireStale, {});
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("queued");
    expect(job?.claimed_by).toBeUndefined();
  });

  test("D13: a stalled confirming job becomes needs_reconciliation, never queued", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);
    await t.mutation(api.jobs.reachedSummary, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      order_summary_total: 300,
      order_summary_currency: "ARS",
      summary_line_items: summaryLines(seeded),
    });
    await t.mutation(api.jobs.confirm, { job_id: jobId });
    await t.mutation(api.jobs.startConfirming, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
    });
    // Simulate a worker that died 20 minutes into the final click.
    await t.run((ctx) =>
      ctx.db.patch(jobId, { confirm_started_at: Date.now() - 20 * 60 * 1000 }),
    );

    await t.mutation(internal.jobs.expireStale, {});
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("needs_reconciliation");
  });

  test("expires an unconfirmed summary and returns the cart to approved", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const jobId = await queueAndClaim(t, seeded);
    await t.mutation(api.jobs.reachedSummary, {
      workerToken: WORKER_TOKEN,
      job_id: jobId,
      worker_id: WORKER_ID,
      order_summary_total: 300,
      order_summary_currency: "ARS",
      summary_line_items: summaryLines(seeded),
    });
    await t.run((ctx) =>
      ctx.db.patch(jobId, { confirm_deadline: Date.now() - 1000 }),
    );

    await t.mutation(internal.jobs.expireStale, {});
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("expired");
    const cart = await t.run((ctx) => ctx.db.get(seeded.cartId));
    expect(cart?.status).toBe("approved");

    // Confirming an expired job must fail.
    await expect(
      t.mutation(api.jobs.confirm, { job_id: jobId }),
    ).rejects.toThrow();
  });
});
