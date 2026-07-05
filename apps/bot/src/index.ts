import { Bot } from "grammy";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().min(1),
});

const env = envSchema.parse(process.env);
const allowedChatIds = new Set(
  env.TELEGRAM_ALLOWED_CHAT_IDS.split(",").map((id) => id.trim()),
);
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id.toString();
  if (!chatId || !allowedChatIds.has(chatId)) return;
  await next();
});

bot.command("start", async (ctx) => {
  await ctx.reply("Household Manager is online.");
});

bot.command("out", async (ctx) => {
  await ctx.reply(
    "Logging via Telegram lands in Phase 5. Use the dashboard reconciliation view for now.",
  );
});

bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery(
    "Confirmation callbacks will call Convex guarded mutations in Phase 5.",
  );
});

void bot.start({
  onStart: (info) => {
    console.log(`Household Manager bot running as @${info.username}`);
  },
});
