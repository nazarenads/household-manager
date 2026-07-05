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
const DEFAULT_CONFIRM_MS = 30 * 60 * 1000;
const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRMING_RECONCILIATION_MS = 15 * 60 * 1000;

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
    if (args.status) {
      return await ctx.db
        .query("purchase_jobs")
        .withIndex("by_status", (q) =>
          q.eq("status", args.status as PurchaseJobStatus),
        )
        .order("desc")
        .collect();
    }
    return await ctx.db.query("purchase_jobs").order("desc").collect();
  },
});

export const get = query({
  args: { id: v.id("purchase_jobs") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.id);
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
    summary_diff: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireWorkerToken(args);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "running" || job.claimed_by !== args.worker_id) {
      throw new ConvexError("Worker does not hold this running job");
    }
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
        summary_diff: args.summary_diff,
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

export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
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
