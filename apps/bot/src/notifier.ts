import { ConvexClient } from "convex/browser";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { api } from "@household/backend/convex/_generated/api";
import type { Id } from "@household/backend/convex/_generated/dataModel";

/**
 * Milliseconds until the next Sunday 20:00 America/Argentina/Buenos_Aires
 * nudge. ART is UTC-3 with no DST, so that is Sunday 23:00 UTC.
 */
export function msUntilNextWeeklyNudge(now: Date): number {
  const target = new Date(now);
  target.setUTCHours(23, 0, 0, 0);
  let addDays = (0 - target.getUTCDay() + 7) % 7;
  if (addDays === 0 && target.getTime() <= now.getTime()) addDays = 7;
  target.setUTCDate(target.getUTCDate() + addDays);
  return target.getTime() - now.getTime();
}

export function startNotifier(
  bot: Bot,
  convexUrl: string,
  botToken: string,
  allowedChatIds: Set<string>,
  allowedUserIds: Set<string>,
) {
  const client = new ConvexClient(convexUrl);

  const jobStatusMap = new Map<Id<"purchase_jobs">, string>();
  const cartStatusMap = new Map<Id<"carts">, string>();
  // Per-subscription seeding flags: the first snapshot after startup is
  // recorded silently (except jobs that need action) so restarts don't
  // replay history. These must flip inside the callbacks — the callbacks
  // fire asynchronously, after startNotifier has already returned.
  let jobsSeeded = false;
  let cartsSeeded = false;
  const actionStatuses = new Set([
    "awaiting_delivery_choice",
    "awaiting_confirm",
    "paused_captcha",
    "needs_reconciliation",
  ]);

  const allChatIds = new Set([
    ...allowedChatIds,
    ...Array.from(allowedUserIds).map((id) => id),
  ]);

  function formatStockDelta(delta: number): string {
    if (Number.isInteger(delta)) return delta.toString();
    return delta.toFixed(2).replace(/\.?0+$/, "");
  }

  function scheduleWeeklyReconciliation() {
    function scheduleNext() {
      const msUntilNext = msUntilNextWeeklyNudge(new Date());
      console.log(`Next weekly reconciliation in ${msUntilNext}ms`);

      setTimeout(async () => {
        const message =
          "🧾 Weekly reconciliation: walk the pantry and correct counts with /set <item> <count>, or use the dashboard sweep.";
        for (const chatId of allChatIds) {
          try {
            await bot.api.sendMessage(chatId, message);
          } catch (err) {
            console.error(`Failed to send weekly message to ${chatId}:`, err);
          }
        }
        scheduleNext();
      }, msUntilNext);
    }

    scheduleNext();
  }

  client.onUpdate(api.bot.jobs, { botToken, limit: 10 }, async (jobs) => {
    const firstSnapshot = !jobsSeeded;
    jobsSeeded = true;
    for (const job of jobs) {
      const previousStatus = jobStatusMap.get(job._id);
      const currentStatus = job.status;
      if (previousStatus === currentStatus) continue;
      jobStatusMap.set(job._id, currentStatus);

      // On startup, seed history silently — but jobs waiting on a human
      // still deserve a (re-)notification.
      if (
        firstSnapshot &&
        previousStatus === undefined &&
        !actionStatuses.has(currentStatus)
      ) {
        continue;
      }

      const storeName = job.store?.name ?? "Unknown store";
      let message = "";
      let replyMarkup:
        { reply_markup: { inline_keyboard: any[][] } } | undefined;

      if (currentStatus === "awaiting_delivery_choice") {
        const options = job.delivery_options ?? [];
        const deadline = job.delivery_choice_deadline
          ? `\nAuto-picks the earliest if nobody answers by ${new Date(
              job.delivery_choice_deadline,
            ).toLocaleString()}`
          : "";
        message = `📅 ${storeName}\nPick a delivery date:${deadline}`;

        const keyboard = new InlineKeyboard();
        options.forEach((option, index) => {
          keyboard
            .text(
              index === 0 ? `${option} (earliest)` : option,
              `job:date:${job._id}:${index}`,
            )
            .row();
        });

        for (const chatId of allChatIds) {
          try {
            await bot.api.sendMessage(chatId, message, {
              reply_markup: keyboard,
            });
          } catch (err) {
            console.error(
              `Failed to send delivery-choice notification to ${chatId}:`,
              err,
            );
          }
        }
      } else if (currentStatus === "awaiting_confirm") {
        const total =
          job.order_summary_total !== undefined
            ? `\nTotal: ${formatStockDelta(job.order_summary_total)} ${
                job.order_summary_currency ?? "ARS"
              }`
            : "";
        const delivery = job.summary_delivery_window
          ? `\nDelivery: ${job.summary_delivery_window}`
          : job.chosen_delivery_option
            ? `\nDelivery: ${job.chosen_delivery_option}`
            : "";
        const deadline = job.confirm_deadline
          ? `\nConfirm by: ${new Date(job.confirm_deadline).toLocaleString()}`
          : "";

        message = `${storeName}\nOrder ready to confirm${total}${delivery}${deadline}`;

        if (
          job.summary_diff &&
          (job.summary_diff as any).withinPolicy === false
        ) {
          message +=
            "\n⚠️ Summary differs from the cart — review in the dashboard before confirming";
        } else {
          const keyboard = new InlineKeyboard().text(
            "Confirm order",
            `job:confirm:${job._id}`,
          );
          replyMarkup = { reply_markup: keyboard };
        }

        for (const chatId of allChatIds) {
          try {
            if (job.order_summary_screenshot_url) {
              await bot.api.sendPhoto(
                chatId,
                job.order_summary_screenshot_url,
                {
                  caption: message,
                  ...replyMarkup,
                },
              );
            } else {
              await bot.api.sendMessage(chatId, message, replyMarkup);
            }
          } catch (err) {
            console.error(`Failed to send job notification to ${chatId}:`, err);
          }
        }
      } else if (currentStatus === "paused_captcha") {
        const errorText = job.error ? `\n${job.error}` : "";
        message = `⏸ ${storeName}: needs a human (captcha/login). Solve it over noVNC, then hit Resume in the dashboard.${errorText}`;

        for (const chatId of allChatIds) {
          try {
            await bot.api.sendMessage(chatId, message);
          } catch (err) {
            console.error(
              `Failed to send pause notification to ${chatId}:`,
              err,
            );
          }
        }
      } else if (currentStatus === "paused_limit") {
        message = `⏸ ${storeName}: executor usage limit hit; resume from the dashboard later.`;

        for (const chatId of allChatIds) {
          try {
            await bot.api.sendMessage(chatId, message);
          } catch (err) {
            console.error(
              `Failed to send limit notification to ${chatId}:`,
              err,
            );
          }
        }
      } else if (currentStatus === "done") {
        message = `✅ ${storeName}: order placed.`;

        for (const chatId of allChatIds) {
          try {
            await bot.api.sendMessage(chatId, message);
          } catch (err) {
            console.error(
              `Failed to send done notification to ${chatId}:`,
              err,
            );
          }
        }
      } else if (currentStatus === "needs_reconciliation") {
        message = `🚨 ${storeName}: unknown outcome after final confirmation — check the store's order history before doing anything.`;

        for (const chatId of allChatIds) {
          try {
            await bot.api.sendMessage(chatId, message);
          } catch (err) {
            console.error(
              `Failed to send reconciliation notification to ${chatId}:`,
              err,
            );
          }
        }
      } else if (currentStatus === "failed") {
        const errorText = job.error ? `\n${job.error}` : "";
        message = `❌ ${storeName}: purchase failed.${errorText}`;

        for (const chatId of allChatIds) {
          try {
            await bot.api.sendMessage(chatId, message);
          } catch (err) {
            console.error(
              `Failed to send failure notification to ${chatId}:`,
              err,
            );
          }
        }
      }
    }
  });

  client.onUpdate(
    api.bot.carts,
    { botToken, status: "proposed", limit: 10 },
    async (carts) => {
      const firstSnapshot = !cartsSeeded;
      cartsSeeded = true;
      for (const cart of carts) {
        const previousStatus = cartStatusMap.get(cart._id);
        const currentStatus = cart.status;
        if (previousStatus === currentStatus) continue;
        cartStatusMap.set(cart._id, currentStatus);
        if (firstSnapshot && previousStatus === undefined) continue;

        if (currentStatus === "proposed") {
          const storeName = cart.store?.name ?? "Unknown store";
          const lines = cart.lines
            .map((line) => {
              const name = line.item?.name ?? "Unknown item";
              const unit = line.item?.unit ?? "unit";
              return `- ${name}: ${formatStockDelta(line.qty)} ${unit}`;
            })
            .join("\n");

          const message = `🛒 New proposed cart for ${storeName}:\n${lines}`;
          const keyboard = new InlineKeyboard().text(
            "Approve",
            `cart:approve:${cart._id}`,
          );

          for (const chatId of allChatIds) {
            try {
              await bot.api.sendMessage(chatId, message, {
                reply_markup: keyboard,
              });
            } catch (err) {
              console.error(
                `Failed to send cart notification to ${chatId}:`,
                err,
              );
            }
          }
        }
      }
    },
  );

  scheduleWeeklyReconciliation();

  console.log("Notifier started");
}
