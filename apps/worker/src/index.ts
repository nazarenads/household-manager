import fs from "node:fs/promises";
import type { Id } from "@household/backend/convex/_generated/dataModel";
import { loadEnv } from "./config/env";
import { WorkerConvex, type JobDoc } from "./convexClient";
import { BrowserManager, expandHome } from "./browser";
import { loadSecrets, type WorkerSecrets } from "./secrets";
import { StagehandExecutor } from "./executors/stagehand";
import { HarnessExecutor } from "./executors/harness";
import { deleteLocalScreenshot } from "./screenshot";
import {
  ExecutorLimitError,
  HumanInterventionError,
  type Executor,
  type PurchaseJobCtx,
} from "./executors/types";

const LEASE_RENEW_MS = 5 * 60 * 1000;
const CAPTCHA_WAIT_MS = 12 * 60 * 60 * 1000;
// The server-side confirm deadline (default 30 min) plus cron cadence and
// slack; the expiry cron is the authority, this only unblocks the worker.
const CONFIRM_WAIT_MS = 65 * 60 * 1000;
const MAX_HUMAN_RESUMES = 2;

async function main() {
  const env = loadEnv();
  const convex = new WorkerConvex({
    convexUrl: env.CONVEX_URL,
    workerToken: env.WORKER_TOKEN,
    workerId: env.WORKER_ID,
  });

  let secrets: WorkerSecrets;
  try {
    secrets = await loadSecrets(env.WORKER_SECRETS_FILE);
  } catch {
    console.warn(
      `No usable secrets file at ${env.WORKER_SECRETS_FILE}; running without store/payment secrets`,
    );
    secrets = { stores: {}, proxies: {}, payments: {} };
  }

  const browser = new BrowserManager({
    profileRoot: env.WORKER_PROFILE_ROOT,
    model: env.STAGEHAND_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    cdpPort: env.WORKER_CDP_PORT,
    headless: env.WORKER_HEADLESS,
  });
  const screenshotDir = expandHome(env.WORKER_SCREENSHOT_DIR);
  await fs.mkdir(screenshotDir, { recursive: true });

  if (!env.ANTHROPIC_API_KEY) {
    console.warn(
      "[worker] ANTHROPIC_API_KEY is not set: stagehand jobs can only replay fully cached trajectories — first-contact runs and selector healing WILL fail (D11 opt-in)",
    );
  }

  const stagehandExecutor = new StagehandExecutor({
    browser,
    convex,
    secrets,
    screenshotDir,
  });
  const executorConfig = await convex.getExecutorConfig();
  const harnessExecutor = new HarnessExecutor({
    browser,
    secrets,
    screenshotDir,
    mcpConfigDir: screenshotDir,
    cli:
      env.HARNESS_CLI ??
      (executorConfig?.harness_cli === "codex" ? "codex" : "claude"),
    allowApiBilling: env.HARNESS_ALLOW_API_BILLING,
  });

  let queue: JobDoc[] = [];
  let busy = false;

  const pump = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift()!;
        try {
          await processJob(job);
        } catch (error) {
          console.error(`Unhandled error processing job ${job._id}:`, error);
        }
      }
    } finally {
      busy = false;
    }
  };

  const processJob = async (queued: JobDoc) => {
    const claimed = await convex.claim(queued._id);
    if (!claimed) return; // taken, already running, or no longer queued
    console.log(`[worker] claimed job ${claimed._id} (${claimed.executor})`);

    const executor: Executor =
      claimed.executor === "harness" ? harnessExecutor : stagehandExecutor;

    const work = await convex.getWorkContext(claimed._id);
    if (!work) {
      await convex.fail(claimed._id, "Work context could not be loaded");
      return;
    }
    const jobCtx: PurchaseJobCtx = { jobId: claimed._id, work };

    const leaseTimer = setInterval(() => {
      convex.renewLease(claimed._id).catch(() => {
        // Not running anymore (paused/awaiting/expired) — harmless.
      });
    }, LEASE_RENEW_MS);

    try {
      // --- Drive to the order summary, with human-resume retries. ---
      let summary = null;
      for (let attempt = 0; summary === null; attempt++) {
        try {
          summary = await executor.runToSummary(jobCtx);
        } catch (error) {
          if (
            error instanceof HumanInterventionError &&
            attempt < MAX_HUMAN_RESUMES
          ) {
            console.log(`[worker] paused for human: ${error.message}`);
            await convex.pauseCaptcha(claimed._id, error.message);
            let resumed: JobDoc | null = null;
            try {
              resumed = await convex.waitForJob(
                claimed._id,
                (job) => job !== null && job.status !== "paused_captcha",
                CAPTCHA_WAIT_MS,
              );
            } catch {
              // Wait timed out; leave the job paused and release the browser.
            }
            if (resumed?.status === "running") continue; // human resumed us
            console.log(
              `[worker] job ${claimed._id} left paused_captcha as ${resumed?.status}; dropping`,
            );
            await executor.abort(jobCtx);
            return;
          }
          if (error instanceof ExecutorLimitError) {
            await convex.pauseLimit(
              claimed._id,
              error.message,
              error.retryAfterMs,
            );
          } else {
            await convex.fail(
              claimed._id,
              error instanceof Error ? error.message : String(error),
            );
          }
          await executor.abort(jobCtx);
          return;
        }
      }

      // --- Publish the summary; browser stays open at the summary page. ---
      let screenshotId;
      if (summary.screenshotPath) {
        const bytes = await fs.readFile(summary.screenshotPath);
        screenshotId = await convex.uploadScreenshot(bytes);
        await deleteLocalScreenshot(summary.screenshotPath);
      }
      await convex.reachedSummary(claimed._id, {
        order_summary_screenshot: screenshotId,
        order_summary_total: summary.total,
        order_summary_currency: summary.currency,
        summary_line_items: summary.lineItems.map((line) => ({
          item_id: line.itemId as Id<"items"> | undefined,
          store_item_id: line.storeItemId as Id<"store_items"> | undefined,
          name: line.name,
          qty: line.qty,
          unit_price: line.unitPrice,
          line_total: line.lineTotal,
          status: line.status,
        })),
        summary_shipping_total: summary.shippingTotal,
        summary_delivery_window: summary.deliveryWindow,
        summary_payment_warning: summary.paymentWarning,
      });
      console.log(
        `[worker] job ${claimed._id} awaiting confirmation (total ${summary.total})`,
      );

      // --- Human gate (D10): confirmed, or expired by the cron. ---
      let decision: JobDoc | null = null;
      try {
        decision = await convex.waitForJob(
          claimed._id,
          (job) =>
            job === null ||
            ["confirmed", "expired", "failed"].includes(job.status),
          CONFIRM_WAIT_MS,
        );
      } catch {
        // Timed out past the server deadline; the expiry cron owns the job.
      }
      if (decision?.status !== "confirmed") {
        console.log(
          `[worker] job ${claimed._id} not confirmed (${decision?.status ?? "timeout"}); closing store tab`,
        );
        await executor.abort(jobCtx);
        return;
      }

      // --- D13: idempotent final click. ---
      try {
        await convex.startConfirming(claimed._id);
      } catch (error) {
        // The final click has NOT happened yet, so failing here is safe.
        await convex.fail(
          claimed._id,
          `startConfirming failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await executor.abort(jobCtx);
        return;
      }
      try {
        const receipt = await executor.confirmPurchase(jobCtx);
        await convex.complete(claimed._id, {
          order_ref: receipt.orderRef,
          receipt_ref: receipt.receiptRef,
          total: receipt.total,
          currency: receipt.currency,
          line_items: receipt.lineItems,
        });
        console.log(`[worker] job ${claimed._id} done (${receipt.orderRef})`);
        await executor.abort(jobCtx);
      } catch (error) {
        // Outcome unknown after the final click may have happened: never
        // retry, never auto-click again. Leave the browser open for human
        // inspection over noVNC.
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[worker] job ${claimed._id} unknown outcome after confirm start: ${message}`,
        );
        await convex.markNeedsReconciliation(claimed._id, message);
      }
    } finally {
      clearInterval(leaseTimer);
    }
  };

  const unsubscribe = convex.onQueuedJobs((jobs) => {
    queue = [...jobs];
    void pump();
  });

  console.log(
    `[worker] ${env.WORKER_ID} subscribed to queued jobs at ${env.CONVEX_URL}`,
  );

  const shutdown = async () => {
    unsubscribe();
    await browser.closeAll();
    convex.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
