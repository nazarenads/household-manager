import { ConvexHttpClient } from "convex/browser";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import { z } from "zod";
import { api } from "@household/backend/convex/_generated/api";
import type { Id } from "@household/backend/convex/_generated/dataModel";

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
    const row = await convex.mutation(api.bot.logStock, {
      botToken,
      itemSearch,
      delta: qty,
      sourceUser: actorFor(ctx),
    });
    await ctx.reply(formatStockChange(row, "Added"));
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("use", async (ctx) => {
  try {
    const { itemSearch, qty } = parseItemQty(commandArgs(ctx), 1);
    const row = await convex.mutation(api.bot.logStock, {
      botToken,
      itemSearch,
      delta: -qty,
      sourceUser: actorFor(ctx),
    });
    await ctx.reply(formatStockChange(row, "Used"));
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("out", async (ctx) => {
  try {
    const itemSearch = commandArgs(ctx);
    if (!itemSearch) throw new Error("Use /out <item>.");
    const row = await convex.mutation(api.bot.reconcileStock, {
      botToken,
      itemSearch,
      actualCount: 0,
      sourceUser: actorFor(ctx),
      note: "Marked out from Telegram",
    });
    await ctx.reply(formatStockChange(row, "Marked out"));
  } catch (error) {
    await replyError(ctx, error);
  }
});

bot.command("set", async (ctx) => {
  try {
    const { itemSearch, actualCount } = parseSetArgs(commandArgs(ctx));
    const row = await convex.mutation(api.bot.reconcileStock, {
      botToken,
      itemSearch,
      actualCount,
      sourceUser: actorFor(ctx),
      note: "Reconciled from Telegram",
    });
    await ctx.reply(formatStockChange(row, "Set"));
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
