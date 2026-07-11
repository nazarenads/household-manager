import { ConvexError, v } from "convex/values";
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { action, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const botParserSchema = z.object({
  item: z.string(),
  delta: z.number(),
  confidence: z.number().min(0).max(1),
});
import { requireBotToken } from "./lib/auth";
import {
  assertCartTransition,
  assertJobTransition,
  type CartStatus,
  type PurchaseJobStatus,
} from "./lib/state";
import { resolveExecutor } from "./lib/executors";

type Ctx = QueryCtx | MutationCtx;

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function itemSearchTerms(item: Doc<"items">) {
  return [item.name, ...item.aliases].map(normalizeSearch).filter(Boolean);
}

async function currentStockForItem(ctx: Ctx, itemId: Id<"items">) {
  const events = await ctx.db
    .query("stock_events")
    .withIndex("by_item", (q) => q.eq("item_id", itemId))
    .collect();
  return events.reduce((sum, event) => sum + event.delta, 0);
}

async function activeItemsWithStock(ctx: Ctx) {
  const items = await ctx.db
    .query("items")
    .withIndex("by_active", (q) => q.eq("active", true))
    .collect();
  const rows = await Promise.all(
    items.map(async (item) => ({
      item,
      currentStock: await currentStockForItem(ctx, item._id),
    })),
  );
  return rows.sort((a, b) => a.item.name.localeCompare(b.item.name));
}

async function matchActiveItems(ctx: Ctx, search: string) {
  const needle = normalizeSearch(search);
  if (!needle) throw new ConvexError("Item name is required");

  const rows = await activeItemsWithStock(ctx);
  const exactMatches = rows.filter(({ item }) =>
    itemSearchTerms(item).includes(needle),
  );
  return exactMatches.length > 0
    ? exactMatches
    : rows.filter(({ item }) =>
        itemSearchTerms(item).some(
          (term) => term.includes(needle) || needle.includes(term),
        ),
      );
}

type ItemResolution =
  | { kind: "match"; item: Doc<"items">; currentStock: number }
  | {
      kind: "ambiguous";
      candidates: Array<{ item_id: Id<"items">; name: string }>;
    };

async function resolveActiveItem(
  ctx: Ctx,
  search: string,
  itemId?: Id<"items">,
): Promise<ItemResolution> {
  if (itemId) {
    const item = await ctx.db.get(itemId);
    if (!item || !item.active) throw new ConvexError("Item not found");
    return {
      kind: "match",
      item,
      currentStock: await currentStockForItem(ctx, itemId),
    };
  }
  const matches = await matchActiveItems(ctx, search);
  if (matches.length === 0) {
    throw new ConvexError(`No active item matched "${search}"`);
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      candidates: matches
        .slice(0, 6)
        .map(({ item }) => ({ item_id: item._id, name: item.name })),
    };
  }
  const match = matches[0]!;
  return { kind: "match", ...match };
}

function serializeStockRow(row: { item: Doc<"items">; currentStock: number }) {
  return {
    item_id: row.item._id,
    name: row.item.name,
    aliases: row.item.aliases,
    category: row.item.category,
    unit: row.item.unit,
    reorder_point: row.item.reorder_point,
    reorder_to: row.item.reorder_to,
    preferred_store_id: row.item.preferred_store_id,
    currentStock: row.currentStock,
  };
}

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

export const stock = query({
  args: { botToken: v.string() },
  handler: async (ctx, args) => {
    requireBotToken(args);
    const rows = await activeItemsWithStock(ctx);
    return rows.map(serializeStockRow);
  },
});

export const lowStock = query({
  args: { botToken: v.string() },
  handler: async (ctx, args) => {
    requireBotToken(args);
    const rows = await activeItemsWithStock(ctx);
    return rows
      .filter(({ item, currentStock }) => currentStock <= item.reorder_point)
      .map(serializeStockRow);
  },
});

export const logStock = mutation({
  args: {
    botToken: v.string(),
    itemSearch: v.string(),
    itemId: v.optional(v.id("items")),
    delta: v.number(),
    sourceUser: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireBotToken(args);
    if (args.delta === 0) {
      throw new ConvexError("Stock delta must not be zero");
    }
    const resolution = await resolveActiveItem(
      ctx,
      args.itemSearch,
      args.itemId,
    );
    if (resolution.kind === "ambiguous") {
      return { kind: "ambiguous" as const, candidates: resolution.candidates };
    }
    const now = Date.now();
    await ctx.db.insert("stock_events", {
      item_id: resolution.item._id,
      delta: args.delta,
      reason: "telegram",
      source_user: args.sourceUser ?? "telegram",
      ...(args.note ? { note: args.note } : {}),
      created_at: now,
    });
    return {
      kind: "logged" as const,
      row: serializeStockRow({
        item: resolution.item,
        currentStock: resolution.currentStock + args.delta,
      }),
    };
  },
});

export const reconcileStock = mutation({
  args: {
    botToken: v.string(),
    itemSearch: v.string(),
    itemId: v.optional(v.id("items")),
    actualCount: v.number(),
    sourceUser: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireBotToken(args);
    if (args.actualCount < 0) {
      throw new ConvexError("Actual count must be zero or greater");
    }
    const resolution = await resolveActiveItem(
      ctx,
      args.itemSearch,
      args.itemId,
    );
    if (resolution.kind === "ambiguous") {
      return { kind: "ambiguous" as const, candidates: resolution.candidates };
    }
    const delta = args.actualCount - resolution.currentStock;
    if (delta !== 0) {
      await ctx.db.insert("stock_events", {
        item_id: resolution.item._id,
        delta,
        reason: "reconciliation",
        source_user: args.sourceUser ?? "telegram",
        ...(args.note ? { note: args.note } : {}),
        created_at: Date.now(),
      });
    }
    return {
      kind: "logged" as const,
      row: serializeStockRow({
        item: resolution.item,
        currentStock: args.actualCount,
      }),
    };
  },
});

export const carts = query({
  args: {
    botToken: v.string(),
    status: v.optional(
      v.union(
        v.literal("proposed"),
        v.literal("approved"),
        v.literal("executing"),
        v.literal("awaiting_confirm"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireBotToken(args);
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 10);
    const carts = args.status
      ? await ctx.db
          .query("carts")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
          .order("desc")
          .take(limit)
      : await ctx.db.query("carts").order("desc").take(limit);

    return await Promise.all(
      carts.map(async (cart) => {
        const store = await ctx.db.get(cart.store_id);
        const lines = await Promise.all(
          cart.lines.map(async (line) => {
            const item = await ctx.db.get(line.item_id);
            const storeItem = line.store_item_id
              ? await ctx.db.get(line.store_item_id)
              : null;
            return {
              ...line,
              item: item
                ? {
                    _id: item._id,
                    name: item.name,
                    unit: item.unit,
                  }
                : null,
              storeItem: storeItem
                ? {
                    _id: storeItem._id,
                    name: storeItem.name,
                  }
                : null,
            };
          }),
        );
        return {
          _id: cart._id,
          status: cart.status,
          approved_by: cart.approved_by,
          created_at: cart.created_at,
          updated_at: cart.updated_at,
          store: store
            ? {
                _id: store._id,
                name: store.name,
                platform: store.platform,
              }
            : null,
          lines,
        };
      }),
    );
  },
});

export const approveCart = mutation({
  args: {
    botToken: v.string(),
    cartId: v.id("carts"),
    sourceUser: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireBotToken(args);
    const actor = args.sourceUser ?? "telegram";
    const cart = await ctx.db.get(args.cartId);
    if (!cart) throw new ConvexError("Cart not found");
    await patchCartStatus(ctx, cart, "approved", actor);
    await ctx.db.patch(cart._id, { approved_by: actor });
    return cart._id;
  },
});

export const queueCart = mutation({
  args: {
    botToken: v.string(),
    cartId: v.id("carts"),
    sourceUser: v.optional(v.string()),
    executor: v.optional(v.union(v.literal("stagehand"), v.literal("harness"))),
  },
  handler: async (ctx, args): Promise<Id<"purchase_jobs">> => {
    requireBotToken(args);
    const actor = args.sourceUser ?? "telegram";
    const cart = await ctx.db.get(args.cartId);
    if (!cart) throw new ConvexError("Cart not found");
    if (cart.status !== "approved") {
      throw new ConvexError("Only approved carts can be queued");
    }

    const openJob = await ctx.db
      .query("purchase_jobs")
      .withIndex("by_cart", (q) => q.eq("cart_id", args.cartId))
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
      args.executor,
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
      note: "Cart queued from Telegram",
      created_at: now,
    });
    await patchCartStatus(ctx, cart, "executing", actor, "Queued for purchase");
    return jobId;
  },
});

export const jobs = query({
  args: {
    botToken: v.string(),
    status: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("running"),
        v.literal("awaiting_delivery_choice"),
        v.literal("awaiting_confirm"),
        v.literal("confirmed"),
        v.literal("confirming"),
        v.literal("done"),
        v.literal("failed"),
        v.literal("paused_captcha"),
        v.literal("paused_limit"),
        v.literal("expired"),
        v.literal("needs_reconciliation"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireBotToken(args);
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 10);
    const jobs = args.status
      ? await ctx.db
          .query("purchase_jobs")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
          .order("desc")
          .take(limit)
      : await ctx.db.query("purchase_jobs").order("desc").take(limit);
    return await Promise.all(
      jobs.map(async (job) => {
        const store = await ctx.db.get(job.store_id);
        return {
          _id: job._id,
          cart_id: job.cart_id,
          status: job.status,
          executor: job.executor,
          order_summary_total: job.order_summary_total,
          order_summary_currency: job.order_summary_currency,
          order_summary_screenshot_url: job.order_summary_screenshot
            ? await ctx.storage.getUrl(job.order_summary_screenshot)
            : null,
          summary_line_items: job.summary_line_items,
          summary_shipping_total: job.summary_shipping_total,
          summary_delivery_window: job.summary_delivery_window,
          summary_payment_warning: job.summary_payment_warning,
          summary_delivery_warning: job.summary_delivery_warning,
          delivery_options: job.delivery_options,
          chosen_delivery_option: job.chosen_delivery_option,
          delivery_choice_deadline: job.delivery_choice_deadline,
          summary_diff: job.summary_diff as
            | { withinPolicy: boolean; issues: Array<Record<string, unknown>> }
            | undefined,
          confirm_deadline: job.confirm_deadline,
          error: job.error,
          updated_at: job.updated_at,
          store: store
            ? {
                _id: store._id,
                name: store.name,
                platform: store.platform,
              }
            : null,
        };
      }),
    );
  },
});

export const parseText = action({
  args: { botToken: v.string(), text: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ item: string; delta: number; confidence: number }> => {
    requireBotToken(args);
    const config: Doc<"ai_config"> | null = await ctx.runQuery(
      internal.config.getAiConfigForTier,
      { tier: "parser" },
    );
    const result = await generateObject({
      model: anthropic(
        config?.model ?? process.env.PARSER_MODEL ?? "claude-haiku-4-5",
      ),
      schema: botParserSchema,
      prompt: [
        "Parse a household stock update into an item name and signed delta.",
        "Use negative deltas for consumption ('used up the coffee', 'no queda yerba'),",
        "positive deltas for additions ('bought 2 packs of rice').",
        "Set confidence low (< 0.5) if the message is not a stock update at all.",
        `Message: ${args.text}`,
      ].join("\n"),
    });
    return result.object;
  },
});

/** Human picks a delivery date from Telegram (by option index, callback-data safe). */
export const chooseDelivery = mutation({
  args: {
    botToken: v.string(),
    jobId: v.id("purchase_jobs"),
    optionIndex: v.number(),
    sourceUser: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireBotToken(args);
    const actor = args.sourceUser ?? "telegram";
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "awaiting_delivery_choice") {
      throw new ConvexError("Job is not awaiting a delivery choice");
    }
    const option = job.delivery_options?.[args.optionIndex];
    if (option === undefined) {
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
        lease_expires_at: Date.now() + 10 * 60 * 1000,
      },
      "Delivery date chosen from Telegram",
    );
    return option;
  },
});

export const confirmJob = mutation({
  args: {
    botToken: v.string(),
    jobId: v.id("purchase_jobs"),
    sourceUser: v.optional(v.string()),
    overrideSummaryDiff: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireBotToken(args);
    const actor = args.sourceUser ?? "telegram";
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new ConvexError("Job not found");
    if (job.status !== "awaiting_confirm") {
      throw new ConvexError("Job is not awaiting confirmation");
    }
    if (job.confirm_deadline && job.confirm_deadline < Date.now()) {
      throw new ConvexError("Confirmation deadline has passed");
    }
    const diff = job.summary_diff as { withinPolicy?: boolean } | undefined;
    if (diff?.withinPolicy === false && !args.overrideSummaryDiff) {
      throw new ConvexError(
        "Summary differs from cart; confirm from the dashboard to inspect it",
      );
    }
    await patchJobStatus(
      ctx,
      job,
      "confirmed",
      actor,
      { confirmed_by: actor, confirmed_at: Date.now() },
      "Human approved final order placement from Telegram",
    );
    return job._id;
  },
});
