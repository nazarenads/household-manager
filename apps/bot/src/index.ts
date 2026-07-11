import { ConvexHttpClient } from "convex/browser";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import { z } from "zod";
import { api } from "@household/backend/convex/_generated/api";
import type { Id } from "@household/backend/convex/_generated/dataModel";
import { startNotifier } from "./notifier";

const rawEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  CONVEX_URL: z.string().url().optional(),
  NEXT_PUBLIC_CONVEX_URL: z.string().url().optional(),
  BOT_CONVEX_TOKEN: z.string().min(1).default("local-dev"),
});

const rawEnv = rawEnvSchema.parse(process.env);
const convexUrl = rawEnv.CONVEX_URL ?? rawEnv.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error("CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required");
}

const allowedChatIds = parseIdSet(rawEnv.TELEGRAM_ALLOWED_CHAT_IDS);
const allowedUserIds = parseIdSet(rawEnv.TELEGRAM_ALLOWED_USER_IDS);
if (allowedChatIds.size === 0 && allowedUserIds.size === 0) {
  throw new Error(
    "TELEGRAM_ALLOWED_CHAT_IDS or TELEGRAM_ALLOWED_USER_IDS is required",
  );
}

const convex = new ConvexHttpClient(convexUrl);
const bot = new Bot(rawEnv.TELEGRAM_BOT_TOKEN);
const botToken = rawEnv.BOT_CONVEX_TOKEN;

type StockRow = Awaited<ReturnType<typeof getStock>>[number];
type CartRow = Awaited<ReturnType<typeof getCarts>>[number];
type JobRow = Awaited<ReturnType<typeof getAwaitingJobs>>[number];

interface PendingAction {
  op: "add" | "use" | "out" | "set";
  qty?: number | undefined;
  count?: number | undefined;
  itemSearch?: string | undefined;
  sourceUser: string;
}

const pendingActions = new Map<string, PendingAction>();
let pendingActionCounter = 0;

function generateShortId(): string {
  pendingActionCounter = (pendingActionCounter + 1) % 1000000;
  return `${pendingActionCounter}`;
}

function storePendingAction(action: PendingAction): string {
  const id = generateShortId();
  pendingActions.set(id, action);
  if (pendingActions.size > 100) {
    const firstKey = pendingActions.keys().next().value;
    if (firstKey) pendingActions.delete(firstKey);
  }
  return id;
}

function parseIdSet(value?: string) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function isAllowed(ctx: Context) {
  const chatId = ctx.chat?.id.toString();
  const userId = ctx.from?.id.toString();
  return (
    (chatId !== undefined && allowedChatIds.has(chatId)) ||
    (userId !== undefined && allowedUserIds.has(userId))
  );
}

function commandArgs(ctx: CommandContext<Context>) {
  return (ctx.message?.text ?? "").replace(/^\/\w+(?:@\w+)?\s*/, "").trim();
}

function actorFor(ctx: Context) {
  if (!ctx.from) return "telegram";
  return ctx.from.username
    ? `telegram:${ctx.from.id}:${ctx.from.username}`
    : `telegram:${ctx.from.id}`;
}

function formatCount(value: number) {
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function parseItemQty(args: string, defaultQty: number) {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Tell me which item to update.");
  }

  const maybeQty = Number(parts.at(-1)?.replace(",", "."));
  if (Number.isFinite(maybeQty) && maybeQty > 0) {
    const itemSearch = parts.slice(0, -1).join(" ").trim();
    if (!itemSearch) throw new Error("Tell me which item to update.");
    return { itemSearch, qty: maybeQty };
  }

  return { itemSearch: args.trim(), qty: defaultQty };
}

function parseSetArgs(args: string) {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Use /set <item> <count>.");
  }
  const actualCount = Number(parts.at(-1)?.replace(",", "."));
  if (!Number.isFinite(actualCount) || actualCount < 0) {
    throw new Error("Count must be zero or greater.");
  }
  return {
    itemSearch: parts.slice(0, -1).join(" ").trim(),
    actualCount,
  };
}

function formatStock(rows: StockRow[]) {
  if (rows.length === 0) return "No active items yet.";
  return rows
    .map(
      (row) =>
        `${row.name}: ${formatCount(row.currentStock)} ${row.unit} ` +
        `(reorder at ${formatCount(row.reorder_point)})`,
    )
    .join("\n");
}

function formatStockChange(row: StockRow, verb: string) {
  return `${verb} ${row.name}. Current stock: ${formatCount(
    row.currentStock,
  )} ${row.unit}.`;
}

function formatCart(cart: CartRow) {
  const storeName = cart.store?.name ?? "Unknown store";
  const lines = cart.lines
    .map((line) => {
      const name = line.item?.name ?? "Unknown item";
      const unit = line.item?.unit ?? "unit";
      return `- ${name}: ${formatCount(line.qty)} ${unit}`;
    })
    .join("\n");
  return [`${storeName} cart`, `Status: ${cart.status}`, lines].join("\n");
}

function formatJob(job: JobRow) {
  const storeName = job.store?.name ?? "Unknown store";
  const total =
    job.order_summary_total !== undefined
      ? `\nTotal: ${formatCount(job.order_summary_total)} ${
          job.order_summary_currency ?? "ARS"
        }`
      : "";
  const deadline = job.confirm_deadline
    ? `\nConfirm by: ${new Date(job.confirm_deadline).toLocaleString()}`
    : "";
  return `${storeName} job\nStatus: ${job.status}${total}${deadline}`;
}

function cartKeyboard(cart: CartRow) {
  const keyboard = new InlineKeyboard();
  if (cart.status === "proposed") {
    keyboard.text("Approve", `cart:approve:${cart._id}`);
  }
  if (cart.status === "approved") {
    keyboard.text("Queue", `cart:queue:${cart._id}`);
  }
  return keyboard;
}

function jobKeyboard(job: JobRow) {
  return new InlineKeyboard().text("Confirm order", `job:confirm:${job._id}`);
}

async function getStock() {
  return await convex.query(api.bot.stock, { botToken });
}

async function getLowStock() {
  return await convex.query(api.bot.lowStock, { botToken });
}

async function getCarts() {
  const carts = await convex.query(api.bot.carts, { botToken, limit: 10 });
  return carts.filter((cart) =>
    ["proposed", "approved", "executing", "awaiting_confirm"].includes(
      cart.status,
    ),
  );
}

async function getAwaitingJobs() {
  return await convex.query(api.bot.jobs, {
    botToken,
    status: "awaiting_confirm",
    limit: 5,
  });
}

async function replyError(ctx: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await ctx.reply(`I couldn't do that: ${message}`);
}

async function handleAmbiguousResult(
  ctx: Context,
  candidates: Array<{ item_id: string; name: string }>,
  op: "add" | "use" | "out" | "set",
  qty?: number | undefined,
  count?: number | undefined,
) {
  const sourceUser = actorFor(ctx);
  const action: PendingAction = {
    op,
    sourceUser,
  };
  if (qty !== undefined) action.qty = qty;
  if (count !== undefined) action.count = count;
  const shortId = storePendingAction(action);

  const keyboard = new InlineKeyboard();
  for (const candidate of candidates) {
    // pick:<counter>:<convex id> stays well under Telegram's 64-byte limit.
    keyboard.text(candidate.name, `pick:${shortId}:${candidate.item_id}`).row();
  }

  await ctx.reply("Which item did you mean?", { reply_markup: keyboard });
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) return;
  await next();
});

bot.command(["start", "help"], async (ctx) => {
  await ctx.reply(
    [
      "Household Manager is online.",
      "",
      "/stock - show current inventory",
      "/low - show items at or under reorder point",
      "/add <item> [qty] - add stock",
      "/use <item> [qty] - consume stock",
      "/out <item> - set an item to zero",
      "/set <item> <count> - reconcile exact stock",
      "/cart - review active carts",
      "/jobs - confirm waiting checkout summaries",
      "",
      "Or just tell me things like 'used up the coffee'",
    ].join("\n"),
  );
});

bot.command("stock", async (ctx) => {
  try {
    await ctx.reply(formatStock(await getStock()));
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("low", async (ctx) => {
  try {
    const rows = await getLowStock();
    await ctx.reply(
      rows.length > 0
        ? `Low stock:\n${formatStock(rows)}`
        : "Nothing is under its reorder point.",
    );
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("add", async (ctx) => {
  try {
    const { itemSearch, qty } = parseItemQty(commandArgs(ctx), 1);
    const result = await convex.mutation(api.bot.logStock, {
      botToken,
      itemSearch,
      delta: qty,
      sourceUser: actorFor(ctx),
    });
    if (result.kind === "ambiguous") {
      await handleAmbiguousResult(ctx, result.candidates, "add", qty);
    } else {
      await ctx.reply(formatStockChange(result.row, "Added"));
    }
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("use", async (ctx) => {
  try {
    const { itemSearch, qty } = parseItemQty(commandArgs(ctx), 1);
    const result = await convex.mutation(api.bot.logStock, {
      botToken,
      itemSearch,
      delta: -qty,
      sourceUser: actorFor(ctx),
    });
    if (result.kind === "ambiguous") {
      await handleAmbiguousResult(ctx, result.candidates, "use", qty);
    } else {
      await ctx.reply(formatStockChange(result.row, "Used"));
    }
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("out", async (ctx) => {
  try {
    const itemSearch = commandArgs(ctx);
    if (!itemSearch) throw new Error("Use /out <item>.");
    const result = await convex.mutation(api.bot.reconcileStock, {
      botToken,
      itemSearch,
      actualCount: 0,
      sourceUser: actorFor(ctx),
      note: "Marked out from Telegram",
    });
    if (result.kind === "ambiguous") {
      await handleAmbiguousResult(ctx, result.candidates, "out", undefined, 0);
    } else {
      await ctx.reply(formatStockChange(result.row, "Marked out"));
    }
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("set", async (ctx) => {
  try {
    const { itemSearch, actualCount } = parseSetArgs(commandArgs(ctx));
    const result = await convex.mutation(api.bot.reconcileStock, {
      botToken,
      itemSearch,
      actualCount,
      sourceUser: actorFor(ctx),
      note: "Reconciled from Telegram",
    });
    if (result.kind === "ambiguous") {
      await handleAmbiguousResult(
        ctx,
        result.candidates,
        "set",
        undefined,
        actualCount,
      );
    } else {
      await ctx.reply(formatStockChange(result.row, "Set"));
    }
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("cart", async (ctx) => {
  try {
    const carts = await getCarts();
    if (carts.length === 0) {
      await ctx.reply("No proposed or active carts right now.");
      return;
    }
    for (const cart of carts) {
      const keyboard = cartKeyboard(cart);
      const options =
        keyboard.inline_keyboard.length > 0
          ? { reply_markup: keyboard }
          : undefined;
      await ctx.reply(formatCart(cart), options);
    }
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("jobs", async (ctx) => {
  try {
    const jobs = await getAwaitingJobs();
    if (jobs.length === 0) {
      await ctx.reply("No checkout summaries are waiting for confirmation.");
      return;
    }
    for (const job of jobs) {
      await ctx.reply(formatJob(job), { reply_markup: jobKeyboard(job) });
    }
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.callbackQuery(/^pick:(\d+):(.+)$/, async (ctx) => {
  try {
    const shortId = ctx.match[1]!;
    const encodedItemId = ctx.match[2]!;
    const pending = pendingActions.get(shortId);
    if (!pending) {
      await ctx.answerCallbackQuery("Expired, try again");
      return;
    }

    const itemId = encodedItemId as Id<"items">;
    const sourceUser = pending!.sourceUser;
    const delta =
      pending.op === "add"
        ? (pending.qty ?? 1)
        : pending.op === "use"
          ? -(pending.qty ?? 1)
          : 0;
    const actualCount =
      pending.op === "set"
        ? (pending.count ?? 0)
        : pending.op === "out"
          ? 0
          : undefined;

    if (pending.op === "add" || pending.op === "use") {
      const result = await convex.mutation(api.bot.logStock, {
        botToken,
        itemSearch: "",
        itemId,
        delta,
        sourceUser,
      });
      if (result.kind === "logged") {
        const verb = pending.op === "add" ? "Added" : "Used";
        await ctx.answerCallbackQuery("Applied");
        await ctx.reply(formatStockChange(result.row, verb));
      } else {
        await ctx.answerCallbackQuery("Still ambiguous");
        await ctx.reply("Still ambiguous, pick again:");
        await handleAmbiguousResult(
          ctx,
          result.candidates,
          pending.op,
          pending.qty,
        );
      }
    } else if (pending.op === "out" || pending.op === "set") {
      const result = await convex.mutation(api.bot.reconcileStock, {
        botToken,
        itemSearch: "",
        itemId,
        actualCount: actualCount ?? 0,
        sourceUser,
        note:
          pending.op === "out"
            ? "Marked out from Telegram"
            : "Reconciled from Telegram",
      });
      if (result.kind === "logged") {
        const verb = pending.op === "out" ? "Marked out" : "Set";
        await ctx.answerCallbackQuery("Applied");
        await ctx.reply(formatStockChange(result.row, verb));
      } else {
        await ctx.answerCallbackQuery("Still ambiguous");
        await ctx.reply("Still ambiguous, pick again:");
        await handleAmbiguousResult(
          ctx,
          result.candidates,
          pending.op,
          undefined,
          pending.count,
        );
      }
    }
    pendingActions.delete(shortId);
  } catch (error) {
    await ctx.answerCallbackQuery("Failed");
    await replyError(ctx, error);
  }
});

bot.callbackQuery(/^cart:approve:(.+)$/, async (ctx) => {
  try {
    const cartId = ctx.match[1] as Id<"carts">;
    await convex.mutation(api.bot.approveCart, {
      botToken,
      cartId,
      sourceUser: actorFor(ctx),
    });
    await ctx.answerCallbackQuery("Cart approved");
    await ctx.reply("Cart approved. Use /cart to queue it when ready.");
  } catch (error) {
    await ctx.answerCallbackQuery("Approval failed");
    await replyError(ctx, error);
  }
});

bot.callbackQuery(/^cart:queue:(.+)$/, async (ctx) => {
  try {
    const cartId = ctx.match[1] as Id<"carts">;
    const jobId = await convex.mutation(api.bot.queueCart, {
      botToken,
      cartId,
      sourceUser: actorFor(ctx),
    });
    await ctx.answerCallbackQuery("Cart queued");
    await ctx.reply(`Cart queued for the worker. Job: ${jobId}`);
  } catch (error) {
    await ctx.answerCallbackQuery("Queue failed");
    await replyError(ctx, error);
  }
});

bot.callbackQuery(/^job:date:([^:]+):(\d+)$/, async (ctx) => {
  try {
    const jobId = ctx.match[1] as Id<"purchase_jobs">;
    const optionIndex = Number(ctx.match[2]);
    const option = await convex.mutation(api.bot.chooseDelivery, {
      botToken,
      jobId,
      optionIndex,
      sourceUser: actorFor(ctx),
    });
    await ctx.answerCallbackQuery("Delivery date set");
    await ctx.reply(
      `Delivery date set: ${option}. The worker is continuing to the order summary.`,
    );
  } catch (error) {
    await ctx.answerCallbackQuery("Choice failed");
    await replyError(ctx, error);
  }
});

bot.callbackQuery(/^job:confirm:(.+)$/, async (ctx) => {
  try {
    const jobId = ctx.match[1] as Id<"purchase_jobs">;
    await convex.mutation(api.bot.confirmJob, {
      botToken,
      jobId,
      sourceUser: actorFor(ctx),
    });
    await ctx.answerCallbackQuery("Order confirmed");
    await ctx.reply(
      "Order confirmation approved. The worker can place it now.",
    );
  } catch (error) {
    await ctx.answerCallbackQuery("Confirmation failed");
    await replyError(ctx, error);
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  try {
    const parsed = await convex.action(api.bot.parseText, {
      botToken,
      text,
    });

    if (parsed.confidence >= 0.8) {
      const result = await convex.mutation(api.bot.logStock, {
        botToken,
        itemSearch: parsed.item,
        delta: parsed.delta,
        sourceUser: actorFor(ctx),
      });
      if (result.kind === "ambiguous") {
        await handleAmbiguousResult(
          ctx,
          result.candidates,
          parsed.delta > 0 ? "add" : "use",
          Math.abs(parsed.delta),
        );
      } else {
        const verb = parsed.delta > 0 ? "Added" : "Used";
        await ctx.reply(formatStockChange(result.row, verb));
      }
    } else if (parsed.confidence >= 0.5 && parsed.confidence < 0.8) {
      const sign = parsed.delta > 0 ? "+" : "";
      const verb = parsed.delta > 0 ? "add" : "use";
      const quantity = Math.abs(parsed.delta);
      const sourceUser = actorFor(ctx);
      const action: PendingAction = {
        op: verb as "add" | "use",
        qty: quantity,
        itemSearch: parsed.item,
        sourceUser,
      };
      const shortId = storePendingAction(action);

      const keyboard = new InlineKeyboard()
        .text("Yes", `apply:${shortId}`)
        .text("Cancel", `cancel:${shortId}`);

      await ctx.reply(`Log ${sign}${quantity} ${parsed.item}?`, {
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(
        "I didn't understand that. Use /add or /use, or tell me more clearly.",
      );
    }
  } catch (error) {
    console.error("parseText error:", error);
    await replyError(ctx, error);
  }
});

bot.callbackQuery(/^apply:(\d+)$/, async (ctx) => {
  try {
    const shortId = ctx.match[1]!;
    const pending = pendingActions.get(shortId);
    if (!pending) {
      await ctx.answerCallbackQuery("Expired, try again");
      return;
    }

    const sourceUser = pending!.sourceUser;
    const itemSearch = pending!.itemSearch ?? "";
    const delta =
      pending.op === "add" ? (pending.qty ?? 1) : -(pending.qty ?? 1);
    const result = await convex.mutation(api.bot.logStock, {
      botToken,
      itemSearch,
      delta,
      sourceUser,
    });

    if (result.kind === "ambiguous") {
      await ctx.answerCallbackQuery("Multiple items matched");
      await handleAmbiguousResult(
        ctx,
        result.candidates,
        pending.op,
        pending.qty,
      );
    } else {
      const verb = pending.op === "add" ? "Added" : "Used";
      await ctx.answerCallbackQuery("Logged");
      await ctx.reply(formatStockChange(result.row, verb));
    }
    pendingActions.delete(shortId);
  } catch (error) {
    await ctx.answerCallbackQuery("Failed");
    await replyError(ctx, error);
  }
});

bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
  const shortId = ctx.match[1]!;
  pendingActions.delete(shortId);
  await ctx.answerCallbackQuery("Cancelled");
  await ctx.reply("Cancelled.");
});

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Bot error while handling update ${ctx.update.update_id}`);
  if (err.error instanceof GrammyError) {
    console.error("Telegram API error:", err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error("Telegram transport error:", err.error);
  } else {
    console.error("Unknown bot error:", err.error);
  }
});

await bot.api.setMyCommands([
  { command: "stock", description: "Show current inventory" },
  { command: "low", description: "Show low-stock items" },
  { command: "add", description: "Add stock: /add item qty" },
  { command: "use", description: "Consume stock: /use item qty" },
  { command: "out", description: "Set an item to zero" },
  { command: "set", description: "Set exact stock count" },
  { command: "cart", description: "Review and approve carts" },
  { command: "jobs", description: "Confirm checkout summaries" },
]);

void bot.start({
  onStart: (info) => {
    console.log(`Household Manager bot running as @${info.username}`);
  },
});

startNotifier(bot, convexUrl, botToken, allowedChatIds, allowedUserIds);
