import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import {
  assertCartTransition,
  assertJobTransition,
  type CartStatus,
} from "./lib/state";
import { resolveExecutor } from "./lib/executors";

async function patchCartStatus(
  ctx: MutationCtx,
  cart: Doc<"carts">,
  status: CartStatus,
  actor: string,
  note?: string,
) {
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

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    if (args.status) {
      return await ctx.db
        .query("carts")
        .withIndex("by_status", (q) =>
          q.eq("status", args.status as CartStatus),
        )
        .order("desc")
        .collect();
    }
    return await ctx.db.query("carts").order("desc").collect();
  },
});

export const get = query({
  args: { id: v.id("carts") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.id);
  },
});

export const createProposed = mutation({
  args: {
    store_id: v.id("stores"),
    lines: v.array(
      v.object({
        item_id: v.id("items"),
        store_item_id: v.optional(v.id("store_items")),
        qty: v.number(),
        expected_unit_price: v.optional(v.number()),
        note: v.optional(v.string()),
      }),
    ),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const now = Date.now();
    const cartId = await ctx.db.insert("carts", {
      store_id: args.store_id,
      status: "proposed",
      lines: args.lines,
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("cart_events", {
      cart_id: cartId,
      to_status: "proposed",
      actor,
      ...(args.note ? { note: args.note } : {}),
      created_at: now,
    });
    return cartId;
  },
});

export const updateLines = mutation({
  args: {
    id: v.id("carts"),
    lines: v.array(
      v.object({
        item_id: v.id("items"),
        store_item_id: v.optional(v.id("store_items")),
        qty: v.number(),
        expected_unit_price: v.optional(v.number()),
        note: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const cart = await ctx.db.get(args.id);
    if (!cart) throw new ConvexError("Cart not found");
    if (!["proposed", "approved"].includes(cart.status)) {
      throw new ConvexError("Cart lines can only be edited before execution");
    }
    await ctx.db.patch(args.id, { lines: args.lines, updated_at: Date.now() });
  },
});

export const approve = mutation({
  args: { id: v.id("carts") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const cart = await ctx.db.get(args.id);
    if (!cart) throw new ConvexError("Cart not found");
    await patchCartStatus(ctx, cart, "approved", actor);
    await ctx.db.patch(cart._id, { approved_by: actor });
  },
});

export const cancel = mutation({
  args: { id: v.id("carts"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const cart = await ctx.db.get(args.id);
    if (!cart) throw new ConvexError("Cart not found");
    await patchCartStatus(ctx, cart, "cancelled", actor, args.note);
  },
});

// CLI admin variant, e.g. npx convex run carts:cancelFromCli '{"cart_id":"..."}'
export const cancelFromCli = internalMutation({
  args: { cart_id: v.id("carts"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const cart = await ctx.db.get(args.cart_id);
    if (!cart) throw new ConvexError("Cart not found");
    await patchCartStatus(
      ctx,
      cart,
      "cancelled",
      "admin-cli",
      args.note ?? "Cancelled from CLI",
    );
  },
});

async function queueCartJob(
  ctx: MutationCtx,
  cart: Doc<"carts">,
  actor: string,
  explicitExecutor?: "stagehand" | "harness",
): Promise<Id<"purchase_jobs">> {
  if (cart.status !== "approved") {
    throw new ConvexError("Only approved carts can be queued");
  }
  const openJob = await ctx.db
    .query("purchase_jobs")
    .withIndex("by_cart", (q) => q.eq("cart_id", cart._id))
    .filter((q) =>
      q.and(
        q.neq(q.field("status"), "done"),
        q.neq(q.field("status"), "failed"),
        q.neq(q.field("status"), "expired"),
      ),
    )
    .first();
  if (openJob) return openJob._id;

  const store = await ctx.db.get(cart.store_id);
  const executor = await resolveExecutor(
    ctx,
    store,
    cart.store_id,
    explicitExecutor,
  );
  const now = Date.now();
  const jobId = await ctx.db.insert("purchase_jobs", {
    cart_id: cart._id,
    store_id: cart.store_id,
    status: "queued",
    executor,
    attempts: 0,
    created_at: now,
    updated_at: now,
  });
  await ctx.db.insert("job_events", {
    job_id: jobId,
    to_status: "queued",
    actor,
    note: "Cart queued for worker execution",
    created_at: now,
  });
  await patchCartStatus(ctx, cart, "executing", actor, "Queued for purchase");
  return jobId;
}

export const queueApproved = mutation({
  args: {
    cart_id: v.id("carts"),
    executor: v.optional(v.union(v.literal("stagehand"), v.literal("harness"))),
  },
  handler: async (ctx, args): Promise<Id<"purchase_jobs">> => {
    const actor = await requireUser(ctx);
    const cart = await ctx.db.get(args.cart_id);
    if (!cart) throw new ConvexError("Cart not found");
    return await queueCartJob(ctx, cart, actor, args.executor);
  },
});

// CLI-only iteration path while validating store flows, e.g.:
//   npx convex run carts:requeueFromCli '{"cart_id":"..."}'
// Supersedes any stale open job, re-approves the cart, and queues it.
export const requeueFromCli = internalMutation({
  args: { cart_id: v.id("carts") },
  handler: async (ctx, args): Promise<Id<"purchase_jobs">> => {
    const actor = "admin-cli";
    const cart = await ctx.db.get(args.cart_id);
    if (!cart) throw new ConvexError("Cart not found");

    const openJobs = await ctx.db
      .query("purchase_jobs")
      .withIndex("by_cart", (q) => q.eq("cart_id", args.cart_id))
      .filter((q) =>
        q.and(
          q.neq(q.field("status"), "done"),
          q.neq(q.field("status"), "failed"),
          q.neq(q.field("status"), "expired"),
        ),
      )
      .collect();
    for (const job of openJobs) {
      const to =
        job.status === "awaiting_confirm"
          ? ("expired" as const)
          : ["queued", "paused_captcha", "paused_limit"].includes(job.status)
            ? ("failed" as const)
            : null;
      if (!to) {
        throw new ConvexError(
          `Cart has an active job in status "${job.status}"; let it finish first`,
        );
      }
      assertJobTransition(job.status, to);
      const now = Date.now();
      await ctx.db.patch(job._id, { status: to, updated_at: now });
      await ctx.db.insert("job_events", {
        job_id: job._id,
        from_status: job.status,
        to_status: to,
        actor,
        note: "Superseded by CLI requeue",
        created_at: now,
      });
    }

    if (cart.status !== "approved") {
      const current = (await ctx.db.get(args.cart_id))!;
      await patchCartStatus(ctx, current, "approved", actor, "CLI requeue");
    }
    const fresh = (await ctx.db.get(args.cart_id))!;
    return await queueCartJob(ctx, fresh, actor);
  },
});
