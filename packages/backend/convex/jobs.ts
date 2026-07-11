import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUser, requireWorkerToken } from "./lib/auth";
import {
  assertCartTransition,
  assertJobTransition,
  type PurchaseJobStatus,
} from "./lib/state";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DELIVERY_CHOICE_TIMEOUT_MS = 30 * 60 * 1000;
const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRMING_RECONCILIATION_MS = 15 * 60 * 1000;
const PRICE_DRIFT_TOLERANCE = 0.15;

type SummaryLineArg = {
  item_id?: Id<"items">;
  store_item_id?: Id<"store_items">;
  name: string;
  qty: number;
  unit_price?: number;
  line_total?: number;
  status: "expected" | "substituted" | "unavailable" | "extra";
};

type ExpectedLine = {
  item_id: Id<"items">;
  store_item_id?: Id<"store_items">;
  qty: number;
  expected_unit_price?: number;
  name: string;
};

export type SummaryDiffIssue = {
  type:
    | "missing"
    | "substituted"
    | "unavailable"
    | "extra"
    | "qty_mismatch"
    | "price_drift";
  name: string;
  expected_qty?: number;
  actual_qty?: number;
  expected_unit_price?: number;
  unit_price?: number;
};

export type SummaryDiff = {
  withinPolicy: boolean;
  issues: SummaryDiffIssue[];
};

function computeSummaryDiff(
  expected: ExpectedLine[],
  summaryLines: SummaryLineArg[],
): SummaryDiff {
  const issues: SummaryDiffIssue[] = [];
  const matched = new Set<number>();

  for (const line of expected) {
    const index = summaryLines.findIndex(
      (summary, i) =>
        !matched.has(i) &&
        ((summary.item_id && summary.item_id === line.item_id) ||
          (summary.store_item_id &&
            line.store_item_id &&
            summary.store_item_id === line.store_item_id)),
    );
    if (index === -1) {
      issues.push({ type: "missing", name: line.name, expected_qty: line.qty });
      continue;
    }
    matched.add(index);
    const summary = summaryLines[index]!;
    if (summary.status === "substituted") {
      issues.push({ type: "substituted", name: summary.name });
    }
    if (summary.status === "unavailable") {
      issues.push({ type: "unavailable", name: summary.name });
      continue;
    }
    if (summary.qty !== line.qty) {
      issues.push({
        type: "qty_mismatch",
        name: summary.name,
        expected_qty: line.qty,
        actual_qty: summary.qty,
      });
    }
    if (
      line.expected_unit_price &&
      summary.unit_price &&
      Math.abs(summary.unit_price - line.expected_unit_price) >
        line.expected_unit_price * PRICE_DRIFT_TOLERANCE
    ) {
      issues.push({
        type: "price_drift",
        name: summary.name,
        expected_unit_price: line.expected_unit_price,
        unit_price: summary.unit_price,
      });
    }
  }

  summaryLines.forEach((summary, index) => {
    if (!matched.has(index)) {
      issues.push({
        type: "extra",
        name: summary.name,
        actual_qty: summary.qty,
      });
    }
  });

  return { withinPolicy: issues.length === 0, issues };
}

async function patchJobStatus(
  ctx: MutationCtx,
  job: Doc<"purchase_jobs">,
  status: PurchaseJobStatus,
  actor: string,
  patch: Record<string, unknown> = {},
  note?: string,
) {
  assertJobTransition(job.status, status);
  const now = Date.now();
  await ctx.db.patch(job._id, { ...patch, status, updated_at: now } as any);
  await ctx.db.insert("job_events", {
    job_id: job._id,
    from_status: job.status,
    to_status: status,
    actor,
    ...(note ? { note } : {}),
    created_at: now,
  });
}

async function patchCartStatus(
  ctx: MutationCtx,
  cartId: Id<"carts">,
  status: Doc<"carts">["status"],
  actor: string,
  note?: string,
) {
  const cart = await ctx.db.get(cartId);
  if (!cart) throw new ConvexError("Cart not found");
  assertCartTransition(cart.status, status);
  const now = Date.now();
  await ctx.db.patch(cart._id, { status, updated_at: now });
  await ctx.db.insert("cart_events", {
    cart_id: cart._id,
    from_status: cart.status,
    to_status: status,
    actor,
    ...(note ? { note } : {}),
    created_at: now,
  });
}

export const getQueued = query({
  args: { workerToken: v.string() },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    return await ctx.db
      .query("purchase_jobs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect();
  },
});

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const jobs = args.status
      ? await ctx.db
          .query("purchase_jobs")
          .withIndex("by_status", (q) =>
            q.eq("status", args.status as PurchaseJobStatus),
          )
          .order("desc")
          .collect()
      : await ctx.db.query("purchase_jobs").order("desc").collect();
    return await Promise.all(
      jobs.map(async (job) => ({
        ...job,
        order_summary_screenshot_url: job.order_summary_screenshot
          ? await ctx.storage.getUrl(job.order_summary_screenshot)
          : null,
      })),
    );
  },
});

export const get = query({
  args: { id: v.id("purchase_jobs") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.id);
  },
});

export const generateUploadUrl = mutation({
  args: { workerToken: v.string() },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    return await ctx.storage.generateUploadUrl();
  },
});

export const getForWorker = query({
  args: { workerToken: v.string(), job_id: v.id("purchase_jobs") },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    return await ctx.db.get(args.job_id);
  },
});

export const getWorkContext = query({
  args: { workerToken: v.string(), job_id: v.id("purchase_jobs") },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) return null;
    const cart = await ctx.db.get(job.cart_id);
    const store = await ctx.db.get(job.store_id);
    if (!cart || !store) return null;
    const lines = await Promise.all(
      cart.lines.map(async (line) => {
        const item = await ctx.db.get(line.item_id);
        const storeItem = line.store_item_id
          ? await ctx.db.get(line.store_item_id)
          : null;
        return {
          ...line,
          item_name: item?.name ?? "Unknown item",
          unit: item?.unit ?? "unit",
          store_item: storeItem
            ? {
                name: storeItem.name,
                product_url: storeItem.product_url,
                sku: storeItem.sku,
                variant: storeItem.variant,
                pack_size: storeItem.pack_size,
                search_terms: storeItem.search_terms,
              }
            : null,
        };
      }),
    );
    return {
      job,
      cart: { _id: cart._id, status: cart.status, lines },
      store: {
        _id: store._id,
        name: store.name,
        platform: store.platform,
        domain: store.domain,
        login_ref: store.login_ref,
        proxy_ref: store.proxy_ref,
        proxy_policy: store.proxy_policy,
        shipping_preference: store.shipping_preference,
        delivery_address: store.delivery_address,
      },
    };
  },
});

export const resume = mutation({
  args: { job_id: v.id("purchase_jobs") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status === "paused_captcha") {
      // The worker stays alive holding the browser; hand the job back to it.
      await patchJobStatus(
        ctx,
        job,
        "running",
        actor,
        {
          error: undefined,
          last_error_code: undefined,
          lease_expires_at: Date.now() + DEFAULT_LEASE_MS,
        },
        "Human resumed after captcha",
      );
      return;
    }
    if (job.status === "paused_limit") {
      await patchJobStatus(
        ctx,
        job,
        "queued",
        actor,
        {
          error: undefined,
          last_error_code: undefined,
          claimed_by: undefined,
          lease_expires_at: undefined,
        },
        "Human requeued after usage limit",
      );
      return;
    }
    throw new ConvexError("Only paused jobs can be resumed");
  },
});

export const claim = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "queued") return null;
    await patchJobStatus(
      ctx,
      job,
      "running",
      args.worker_id,
      {
        claimed_by: args.worker_id,
        lease_expires_at: Date.now() + DEFAULT_LEASE_MS,
        attempts: job.attempts + 1,
      },
      "Worker claimed job",
    );
    return await ctx.db.get(job._id);
  },
});

export const renewLease = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "running" || job.claimed_by !== args.worker_id) {
      throw new ConvexError("Worker does not hold this lease");
    }
    await ctx.db.patch(job._id, {
      lease_expires_at: Date.now() + DEFAULT_LEASE_MS,
      updated_at: Date.now(),
    });
  },
});

/**
 * Worker found more than one delivery date at the shipping step: publish the
 * options (in the order the store displays them — earliest first) and park
 * the job until a human picks one or the worker's auto-earliest fallback
 * fires. Nothing is purchased from this state; the confirm gate still follows.
 */
export const awaitDeliveryChoice = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    delivery_options: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "running" || job.claimed_by !== args.worker_id) {
      throw new ConvexError("Worker does not hold this running job");
    }
    if (args.delivery_options.length === 0) {
      throw new ConvexError("Delivery options must not be empty");
    }
    await patchJobStatus(
      ctx,
      job,
      "awaiting_delivery_choice",
      args.worker_id,
      {
        delivery_options: args.delivery_options,
        chosen_delivery_option: undefined,
        delivery_chosen_by: undefined,
        delivery_choice_deadline: Date.now() + DELIVERY_CHOICE_TIMEOUT_MS,
        lease_expires_at: undefined,
      },
      "Waiting for a delivery date choice",
    );
  },
});

async function applyDeliveryChoice(
  ctx: MutationCtx,
  job: Doc<"purchase_jobs">,
  option: string,
  actor: string,
  note: string,
) {
  if (job.status !== "awaiting_delivery_choice") {
    throw new ConvexError("Job is not awaiting a delivery choice");
  }
  if (!job.delivery_options?.includes(option)) {
    throw new ConvexError("Unknown delivery option");
  }
  await patchJobStatus(
    ctx,
    job,
    "running",
    actor,
    {
      chosen_delivery_option: option,
      delivery_chosen_by: actor,
      delivery_choice_deadline: undefined,
      lease_expires_at: Date.now() + DEFAULT_LEASE_MS,
    },
    note,
  );
}

/** Human picks a delivery date from the dashboard. */
export const chooseDelivery = mutation({
  args: { job_id: v.id("purchase_jobs"), option: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    await applyDeliveryChoice(
      ctx,
      job,
      args.option,
      actor,
      "Delivery date chosen from dashboard",
    );
  },
});

/**
 * Worker fallback: nobody answered within the worker's wait window, so it
 * resumes with the earliest option. Safe because the awaiting_confirm human
 * gate still stands between this and any purchase.
 */
export const resumeDeliveryDefault = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    option: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.claimed_by !== args.worker_id) {
      throw new ConvexError("Worker does not hold this job");
    }
    if (job.status !== "awaiting_delivery_choice") return; // human beat us to it
    await applyDeliveryChoice(
      ctx,
      job,
      args.option,
      args.worker_id,
      "No answer in time; defaulted to the earliest delivery date",
    );
  },
});

export const reachedSummary = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    order_summary_screenshot: v.optional(v.id("_storage")),
    order_summary_total: v.number(),
    order_summary_currency: v.literal("ARS"),
    summary_line_items: v.array(
      v.object({
        item_id: v.optional(v.id("items")),
        store_item_id: v.optional(v.id("store_items")),
        name: v.string(),
        qty: v.number(),
        unit_price: v.optional(v.number()),
        line_total: v.optional(v.number()),
        status: v.union(
          v.literal("expected"),
          v.literal("substituted"),
          v.literal("unavailable"),
          v.literal("extra"),
        ),
      }),
    ),
    summary_shipping_total: v.optional(v.number()),
    summary_delivery_window: v.optional(v.string()),
    summary_payment_warning: v.optional(v.string()),
    summary_delivery_warning: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "running" || job.claimed_by !== args.worker_id) {
      throw new ConvexError("Worker does not hold this running job");
    }
    const cart = await ctx.db.get(job.cart_id);
    if (!cart) throw new ConvexError("Cart not found");
    const expected: ExpectedLine[] = await Promise.all(
      cart.lines.map(async (line) => ({
        ...line,
        name: (await ctx.db.get(line.item_id))?.name ?? "Unknown item",
      })),
    );
    const summaryDiff = computeSummaryDiff(expected, args.summary_line_items);
    const config = await ctx.db.query("executor_config").first();
    const timeoutMs = (config?.confirm_timeout_minutes ?? 30) * 60 * 1000;
    const now = Date.now();
    await patchJobStatus(
      ctx,
      job,
      "awaiting_confirm",
      args.worker_id,
      {
        order_summary_screenshot: args.order_summary_screenshot,
        order_summary_screenshot_expires_at: args.order_summary_screenshot
          ? now + SCREENSHOT_TTL_MS
          : undefined,
        order_summary_total: args.order_summary_total,
        order_summary_currency: args.order_summary_currency,
        summary_line_items: args.summary_line_items,
        summary_shipping_total: args.summary_shipping_total,
        summary_delivery_window: args.summary_delivery_window,
        summary_payment_warning: args.summary_payment_warning,
        summary_delivery_warning: args.summary_delivery_warning,
        summary_diff: summaryDiff,
        confirm_deadline: now + timeoutMs,
        lease_expires_at: undefined,
      },
      "Reached checkout summary",
    );
    await patchCartStatus(
      ctx,
      job.cart_id,
      "awaiting_confirm",
      args.worker_id,
      "Awaiting final order approval",
    );
  },
});

export const confirm = mutation({
  args: {
    job_id: v.id("purchase_jobs"),
    override_summary_diff: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "awaiting_confirm") {
      throw new ConvexError("Job is not awaiting confirmation");
    }
    if (job.confirm_deadline && job.confirm_deadline < Date.now()) {
      throw new ConvexError("Confirmation deadline has passed");
    }
    const diff = job.summary_diff as { withinPolicy?: boolean } | undefined;
    if (diff?.withinPolicy === false && !args.override_summary_diff) {
      throw new ConvexError(
        "Summary differs from cart; explicit override required",
      );
    }
    await patchJobStatus(
      ctx,
      job,
      "confirmed",
      actor,
      { confirmed_by: actor, confirmed_at: Date.now() },
      "Human approved final order placement",
    );
  },
});

export const startConfirming = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.claimed_by && job.claimed_by !== args.worker_id) {
      throw new ConvexError("Another worker holds this job");
    }
    await patchJobStatus(
      ctx,
      job,
      "confirming",
      args.worker_id,
      { confirm_started_at: Date.now(), claimed_by: args.worker_id },
      "Worker is about to click final confirmation once",
    );
  },
});

export const complete = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    order_ref: v.optional(v.string()),
    receipt_ref: v.optional(v.string()),
    total: v.number(),
    currency: v.literal("ARS"),
    line_items: v.array(
      v.object({ name: v.string(), qty: v.number(), price: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "confirming") {
      throw new ConvexError("Job must be confirming before completion");
    }
    // A completion with no order reference is exactly how a rejected submit
    // masquerades as success (the extractor reads totals off the still-open
    // payment page). Refuse it; the worker reports needs_reconciliation.
    if (!args.order_ref || args.order_ref.trim().length === 0) {
      throw new ConvexError(
        "Refusing completion without an order reference; use markNeedsReconciliation",
      );
    }
    const now = Date.now();
    const existingLedger = await ctx.db
      .query("ledger")
      .withIndex("by_job", (q) => q.eq("job_id", job._id))
      .first();
    if (!existingLedger) {
      await ctx.db.insert("ledger", {
        job_id: job._id,
        store_id: job.store_id,
        status: "placed",
        total: args.total,
        currency: args.currency,
        ...(args.order_ref ? { order_ref: args.order_ref } : {}),
        ...(args.receipt_ref ? { receipt_ref: args.receipt_ref } : {}),
        line_items: args.line_items,
        placed_at: now,
        created_at: now,
        updated_at: now,
      });
    }
    await patchJobStatus(
      ctx,
      job,
      "done",
      args.worker_id,
      { order_ref: args.order_ref, lease_expires_at: undefined },
      "Order placed",
    );
    await patchCartStatus(
      ctx,
      job.cart_id,
      "completed",
      args.worker_id,
      "Order placed",
    );
  },
});

export const pauseCaptcha = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    await patchJobStatus(
      ctx,
      job,
      "paused_captcha",
      args.worker_id,
      {
        error: args.error,
        last_error_code: "captcha",
        lease_expires_at: undefined,
      },
      "Captcha requires human recovery",
    );
  },
});

export const pauseLimit = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    retry_after_ms: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    await patchJobStatus(
      ctx,
      job,
      "paused_limit",
      args.worker_id,
      {
        error: args.error,
        last_error_code: "usage_limit",
        lease_expires_at: args.retry_after_ms
          ? Date.now() + args.retry_after_ms
          : undefined,
      },
      "Executor usage limit reached",
    );
  },
});

export const markNeedsReconciliation = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    await patchJobStatus(
      ctx,
      job,
      "needs_reconciliation",
      args.worker_id,
      { error: args.error, last_error_code: "unknown_confirm_outcome" },
      "Unknown outcome after final confirmation started",
    );
  },
});

export const fail = mutation({
  args: {
    workerToken: v.string(),
    job_id: v.id("purchase_jobs"),
    worker_id: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    await patchJobStatus(
      ctx,
      job,
      "failed",
      args.worker_id,
      { error: args.error, lease_expires_at: undefined },
      "Worker failed job",
    );
    await patchCartStatus(
      ctx,
      job.cart_id,
      "failed",
      args.worker_id,
      args.error,
    );
  },
});

/**
 * Admin/test helper (CLI only): answer the delivery gate like a human would,
 * by option index. Used for unattended end-to-end testing.
 */
export const adminChooseDelivery = internalMutation({
  args: { job_id: v.id("purchase_jobs"), option_index: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    const option = job.delivery_options?.[args.option_index];
    if (option === undefined) throw new ConvexError("Unknown delivery option");
    await applyDeliveryChoice(
      ctx,
      job,
      option,
      "admin-cli",
      "Delivery date chosen from CLI (test)",
    );
    return option;
  },
});

/**
 * Admin/test helper (CLI only): force-expire a job stuck at a human gate so
 * test runs can be cycled without waiting for the deadline cron. Returns the
 * cart to approved exactly like the cron would.
 */
export const adminExpire = internalMutation({
  args: { job_id: v.id("purchase_jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status === "awaiting_confirm") {
      await patchJobStatus(
        ctx,
        job,
        "expired",
        "admin-cli",
        { lease_expires_at: undefined },
        "Force-expired from CLI (test)",
      );
      await patchCartStatus(
        ctx,
        job.cart_id,
        "approved",
        "admin-cli",
        "Cart returned to approved after forced expiry",
      );
      return "expired";
    }
    if (job.status === "awaiting_delivery_choice") {
      await patchJobStatus(
        ctx,
        job,
        "queued",
        "admin-cli",
        {
          claimed_by: undefined,
          lease_expires_at: undefined,
          delivery_options: undefined,
          delivery_choice_deadline: undefined,
        },
        "Force-requeued from CLI (test)",
      );
      return "requeued";
    }
    throw new ConvexError(`Job is "${job.status}"; nothing to expire`);
  },
});

/**
 * Admin repair (CLI only) for a false completion: a job marked done whose
 * order the store never actually placed (verified by a human against the
 * store's order history). Deletes the phantom ledger row, fails the job, and
 * returns the cart to approved for a clean requeue. Deliberately bypasses the
 * transition guards — done/completed are terminal for machines, and this is
 * the human override.
 *
 *   npx convex run jobs:repairFalseCompletion '{"job_id":"..."}'
 */
export const repairFalseCompletion = internalMutation({
  args: { job_id: v.id("purchase_jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "done") {
      throw new ConvexError(
        `Job is "${job.status}", not "done" — nothing to repair`,
      );
    }
    const now = Date.now();
    const ledgerRows = await ctx.db
      .query("ledger")
      .withIndex("by_job", (q) => q.eq("job_id", job._id))
      .collect();
    for (const row of ledgerRows) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.patch(job._id, {
      status: "failed",
      error:
        "False completion repaired by admin: the store never placed this order",
      order_ref: undefined,
      updated_at: now,
    } as any);
    await ctx.db.insert("job_events", {
      job_id: job._id,
      from_status: "done",
      to_status: "failed",
      actor: "admin-repair",
      note: "Phantom completion reverted; ledger row(s) deleted",
      created_at: now,
    });
    const cart = await ctx.db.get(job.cart_id);
    if (cart && cart.status === "completed") {
      await ctx.db.patch(cart._id, { status: "approved", updated_at: now });
      await ctx.db.insert("cart_events", {
        cart_id: cart._id,
        from_status: "completed",
        to_status: "approved",
        actor: "admin-repair",
        note: "Returned to approved after false completion repair",
        created_at: now,
      });
    }
    return {
      jobId: job._id,
      deletedLedgerRows: ledgerRows.length,
      cartStatus: cart ? "approved" : "missing",
    };
  },
});

export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const screenshotJobs = await ctx.db.query("purchase_jobs").collect();
    for (const job of screenshotJobs) {
      if (
        job.order_summary_screenshot &&
        job.order_summary_screenshot_expires_at &&
        job.order_summary_screenshot_expires_at <= now
      ) {
        await ctx.storage.delete(job.order_summary_screenshot);
        await ctx.db.patch(job._id, {
          order_summary_screenshot: undefined,
          order_summary_screenshot_expires_at: undefined,
          updated_at: now,
        } as any);
        await ctx.db.insert("job_events", {
          job_id: job._id,
          from_status: job.status,
          to_status: job.status,
          actor: "cron",
          note: "Expired checkout summary screenshot removed",
          created_at: now,
        });
      }
    }

    const awaiting = await ctx.db
      .query("purchase_jobs")
      .withIndex("by_status", (q) => q.eq("status", "awaiting_confirm"))
      .collect();
    for (const job of awaiting) {
      if (job.confirm_deadline && job.confirm_deadline <= now) {
        await patchJobStatus(
          ctx,
          job,
          "expired",
          "cron",
          { lease_expires_at: undefined },
          "Confirmation deadline expired",
        );
        await patchCartStatus(
          ctx,
          job.cart_id,
          "approved",
          "cron",
          "Cart returned to approved after expiry",
        );
      }
    }

    // A live worker auto-picks the earliest date well before this deadline;
    // reaching it means the worker died mid-gate — requeue for a fresh run.
    const awaitingDelivery = await ctx.db
      .query("purchase_jobs")
      .withIndex("by_status", (q) => q.eq("status", "awaiting_delivery_choice"))
      .collect();
    for (const job of awaitingDelivery) {
      if (
        job.delivery_choice_deadline &&
        job.delivery_choice_deadline <= now
      ) {
        await patchJobStatus(
          ctx,
          job,
          "queued",
          "cron",
          {
            claimed_by: undefined,
            lease_expires_at: undefined,
            delivery_options: undefined,
            delivery_choice_deadline: undefined,
          },
          "Delivery choice deadline expired with no worker fallback",
        );
      }
    }

    const running = await ctx.db
      .query("purchase_jobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    for (const job of running) {
      if (job.lease_expires_at && job.lease_expires_at <= now) {
        await patchJobStatus(
          ctx,
          job,
          "queued",
          "cron",
          {
            claimed_by: undefined,
            lease_expires_at: undefined,
          },
          "Lease expired before final confirmation",
        );
      }
    }

    const confirming = await ctx.db
      .query("purchase_jobs")
      .withIndex("by_status", (q) => q.eq("status", "confirming"))
      .collect();
    for (const job of confirming) {
      if (
        job.confirm_started_at &&
        job.confirm_started_at + CONFIRMING_RECONCILIATION_MS <= now
      ) {
        await patchJobStatus(
          ctx,
          job,
          "needs_reconciliation",
          "cron",
          { last_error_code: "confirming_timeout" },
          "Final confirmation outcome is unknown",
        );
      }
    }
  },
});
