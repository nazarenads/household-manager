import type { ReceiptResult, SummaryResult } from "@household/shared";
import type { Id } from "@household/backend/convex/_generated/dataModel";
import type { BrowserManager, BrowserSession } from "../browser";
import type { WorkerConvex, WorkContext } from "../convexClient";
import type { WorkerSecrets } from "../secrets";
import { TrajectoryRunner } from "../trajectory";
import { captureRedactedScreenshot } from "../screenshot";
import { fillPaymentIfPresent } from "../payment";
import * as tiendanube from "../flows/tiendanube";
import {
  ExecutorLimitError,
  HumanInterventionError,
  isLimitError,
  type Executor,
  type PurchaseJobCtx,
} from "./types";

export type StagehandExecutorOptions = {
  browser: BrowserManager;
  convex: WorkerConvex;
  secrets: WorkerSecrets;
  screenshotDir: string;
};

function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a: string, b: string) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = right.split(" ");
  const shared = rightTokens.filter((token) => leftTokens.has(token)).length;
  return shared / Math.max(leftTokens.size, rightTokens.length) >= 0.5;
}

/**
 * Executor A: Stagehand over the worker-owned local Chrome. Cached
 * trajectories replay with zero LLM calls; extract() calls are always LLM
 * (that is the expected per-run cost). Currently implements the Tienda Nube
 * flow shape; other platforms get their own templates in later phases.
 */
export class StagehandExecutor implements Executor {
  private readonly options: StagehandExecutorOptions;

  constructor(options: StagehandExecutorOptions) {
    this.options = options;
  }

  async runToSummary(job: PurchaseJobCtx): Promise<SummaryResult> {
    const { work } = job;
    this.assertSupportedPlatform(work);
    const session = await this.options.browser.ensureSession(work.store._id);
    const metricsBefore = await session.stagehand.metrics;

    try {
      await this.assertLoggedIn(session, work);
      await this.buildCart(session, work);
      await this.checkoutToSummary(session, work);
      const summary = await this.extractSummary(session, work);
      console.log(
        `[stagehand] summary reached for job ${job.jobId}; LLM tokens this run: ${
          (await session.stagehand.metrics).totalPromptTokens -
          metricsBefore.totalPromptTokens
        }`,
      );
      return summary;
    } catch (error) {
      await this.rethrowClassified(session, error);
      throw error; // unreachable; rethrowClassified always throws
    }
  }

  async confirmPurchase(job: PurchaseJobCtx): Promise<ReceiptResult> {
    const { work } = job;
    const session = await this.options.browser.ensureSession(work.store._id);
    try {
      // Some checkouts ask for card data only at the very end; refresh the
      // best-effort deterministic fill before the single final click.
      await fillPaymentIfPresent(
        session.page,
        this.options.secrets,
        this.paymentRef(work),
      );
      const runner = this.runner(session, work.store._id);
      await runner.runFlow("confirm", [tiendanube.confirmStep]);
      const receipt = await session.stagehand.extract(
        tiendanube.extractInstructions.receipt,
        tiendanube.receiptExtractSchema,
      );
      return {
        orderRef: receipt.orderNumber,
        total: receipt.total,
        currency: "ARS",
        lineItems: receipt.lines.map((line) => ({
          name: line.name,
          qty: line.qty,
          price: line.price,
        })),
      };
    } catch (error) {
      await this.rethrowClassified(session, error);
      throw error;
    }
  }

  async abort(job: PurchaseJobCtx): Promise<void> {
    void job;
    await this.options.browser.closeSession();
  }

  private assertSupportedPlatform(work: WorkContext) {
    if (work.store.platform !== "tiendanube") {
      throw new Error(
        `StagehandExecutor has no flow templates for platform "${work.store.platform}" yet (Phase 3+)`,
      );
    }
  }

  private runner(session: BrowserSession, storeId: Id<"stores">) {
    return new TrajectoryRunner({
      convex: this.options.convex,
      stagehand: session.stagehand,
      storeId,
    });
  }

  /**
   * Cookie/consent banners overlay the header and quietly swallow clicks
   * aimed at the search box and checkout buttons. Dismiss them
   * deterministically after every navigation (single inline expression —
   * Stagehand's evaluate serializer rejects named inner helpers).
   */
  private async dismissOverlays(session: BrowserSession) {
    await session.page.waitForTimeout(800);
    const clicked = await session.page.evaluate(
      () =>
        [...document.querySelectorAll("a, button")].filter(
          (el) =>
            (el as HTMLElement).offsetParent !== null &&
            ["entendido", "aceptar", "acepto", "ok"].includes(
              (el.textContent ?? "").trim().toLowerCase(),
            ) &&
            ((el as HTMLElement).click(), true),
        ).length,
    );
    if (typeof clicked === "number" && clicked > 0) {
      console.log(`[stagehand] dismissed ${clicked} consent overlay(s)`);
      await session.page.waitForTimeout(500);
    }
  }

  private async assertLoggedIn(session: BrowserSession, work: WorkContext) {
    await session.page.goto(tiendanube.accountUrl(work.store.domain));
    await this.dismissOverlays(session);
    await this.assertNoCaptcha(session);
    if (tiendanube.isLoginUrl(session.page.url())) {
      throw new HumanInterventionError(
        `Not logged in at ${work.store.domain}; log in over noVNC (profile persists), then resume`,
      );
    }
  }

  private async buildCart(session: BrowserSession, work: WorkContext) {
    const runner = this.runner(session, work.store._id);
    for (const line of work.cart.lines) {
      const productUrl = line.store_item?.product_url;
      if (productUrl) {
        await session.page.goto(productUrl);
        await this.dismissOverlays(session);
        await runner.runFlow(
          "add_to_cart",
          tiendanube.addToCartSteps(line.qty),
        );
      } else {
        const searchTerm =
          line.store_item?.search_terms[0] ??
          line.store_item?.name ??
          line.item_name;
        await session.page.goto(tiendanube.homeUrl(work.store.domain));
        await this.dismissOverlays(session);
        await runner.runFlow(
          "add_to_cart_search",
          tiendanube.addToCartViaSearchSteps(searchTerm, line.qty),
        );
      }
    }
  }

  private async checkoutToSummary(session: BrowserSession, work: WorkContext) {
    await session.page.goto(tiendanube.cartUrl(work.store.domain));
    await this.dismissOverlays(session);
    const runner = this.runner(session, work.store._id);
    await runner.runFlow(
      "checkout_to_summary",
      tiendanube.checkoutToSummarySteps(work.store.shipping_preference),
    );
    const fill = await fillPaymentIfPresent(
      session.page,
      this.options.secrets,
      this.paymentRef(work),
    );
    if (fill.attempted && fill.filledFields.length > 0) {
      console.log(
        `[stagehand] deterministic payment fill: ${fill.filledFields.join(", ")}`,
      );
    }
  }

  private async extractSummary(
    session: BrowserSession,
    work: WorkContext,
  ): Promise<SummaryResult> {
    const extracted = await session.stagehand.extract(
      tiendanube.extractInstructions.summary,
      tiendanube.summaryExtractSchema,
    );

    const shot = await captureRedactedScreenshot({
      page: session.page,
      platform: work.store.platform,
      outputDir: this.options.screenshotDir,
      name: `summary-${work.job._id}-${Date.now()}`,
    });

    const lineItems = extracted.lines.map((line) => {
      const matched = work.cart.lines.find(
        (cartLine) =>
          namesMatch(line.name, cartLine.store_item?.name ?? "") ||
          namesMatch(line.name, cartLine.item_name),
      );
      return {
        itemId: matched?.item_id as string | undefined,
        storeItemId: matched?.store_item_id as string | undefined,
        name: line.name,
        qty: line.qty,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        status:
          line.availability === "available"
            ? ("expected" as const)
            : (line.availability as "substituted" | "unavailable"),
      };
    });

    return {
      screenshotPath: shot.filePath,
      total: extracted.total,
      currency: "ARS",
      lineItems,
      shippingTotal: extracted.shippingTotal,
      deliveryWindow: extracted.deliveryWindow,
      redactionApplied: shot.redactionApplied,
    };
  }

  private paymentRef(work: WorkContext) {
    const storeSecrets = this.options.secrets.stores[work.store.login_ref];
    return storeSecrets?.paymentRef;
  }

  /**
   * Classify a raw failure before surfacing it: usage limits become
   * ExecutorLimitError (paused_limit), captcha walls become
   * HumanInterventionError (paused_captcha), everything else rethrows as-is.
   */
  private async rethrowClassified(
    session: BrowserSession,
    error: unknown,
  ): Promise<never> {
    if (
      error instanceof HumanInterventionError ||
      error instanceof ExecutorLimitError
    ) {
      throw error;
    }
    if (isLimitError(error)) {
      throw new ExecutorLimitError((error as Error).message);
    }
    try {
      const captcha = await session.stagehand.extract(
        tiendanube.extractInstructions.captchaState,
        tiendanube.captchaStateSchema,
      );
      if (captcha.captchaVisible) {
        throw new HumanInterventionError(
          `Captcha blocking checkout: ${captcha.description ?? "unknown challenge"}`,
        );
      }
    } catch (captchaProbeError) {
      if (captchaProbeError instanceof HumanInterventionError) {
        throw captchaProbeError;
      }
      // Probe failed; fall through to the original error.
    }
    throw error;
  }

  private async assertNoCaptcha(session: BrowserSession) {
    const captcha = await session.stagehand.extract(
      tiendanube.extractInstructions.captchaState,
      tiendanube.captchaStateSchema,
    );
    if (captcha.captchaVisible) {
      throw new HumanInterventionError(
        `Captcha visible: ${captcha.description ?? "unknown challenge"}`,
      );
    }
  }
}
