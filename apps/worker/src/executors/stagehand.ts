import type { ReceiptResult, SummaryResult } from "@household/shared";
import type { Id } from "@household/backend/convex/_generated/dataModel";
import type { BrowserManager, BrowserSession } from "../browser";
import type { JobDoc, WorkerConvex, WorkContext } from "../convexClient";
import type { WorkerSecrets } from "../secrets";
import { actOrThrow } from "../act";
import { TrajectoryRunner } from "../trajectory";
import { captureRedactedScreenshot } from "../screenshot";
import { fillPaymentIfPresent, paymentWarningFor } from "../payment";
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

// How long the worker holds the browser at the delivery-date gate before
// defaulting to the earliest option. The server-side deadline (30 min, cron
// requeue) is the dead-worker backstop, so this must stay well under it.
const DELIVERY_CHOICE_WAIT_MS = 15 * 60 * 1000;
const MAX_DELIVERY_OPTIONS = 8;

/** Accent-stripped, whitespace-collapsed lowercase for page-text matching. */
function normalizeForPageMatch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

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
      await this.reconcileCartQuantities(session, work);
      const { fill, delivery } = await this.checkoutToSummary(session, job);
      const summary = await this.extractSummary(session, work);
      summary.paymentWarning = paymentWarningFor(fill);
      if (summary.paymentWarning) {
        console.log(`[stagehand] payment warning: ${summary.paymentWarning}`);
      }
      summary.deliveryWarning = delivery.warning;
      if (
        !summary.deliveryWarning &&
        delivery.chosen &&
        summary.deliveryWindow &&
        !this.deliveryMatches(summary.deliveryWindow, delivery.chosen)
      ) {
        summary.deliveryWarning = `You chose "${delivery.chosen}" but the order summary shows "${summary.deliveryWindow}" — fix it over noVNC or let this expire.`;
      }
      if (summary.deliveryWarning) {
        console.log(`[stagehand] delivery warning: ${summary.deliveryWarning}`);
      }
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
      // Let the submit round-trip settle before judging the outcome.
      await session.page.waitForTimeout(4000);
      const receipt = await session.stagehand.extract(
        tiendanube.extractInstructions.receipt,
        tiendanube.receiptExtractSchema,
      );
      // Never report done off an ambiguous page: a rejected submit (empty
      // card form, validation error) leaves the checkout on screen, which
      // must end in needs_reconciliation, not a phantom ledger row.
      if (!receipt.orderPlaced || !receipt.orderNumber) {
        throw new Error(
          `Store did not confirm the order (orderPlaced=${receipt.orderPlaced}, orderNumber=${receipt.orderNumber ?? "none"}) — the confirm click likely did not go through (unfilled card form?). Check the browser over noVNC and the store's order history.`,
        );
      }
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

  /**
   * LLM-set product-page quantities don't reliably register (themes keep
   * their own counter and ignore programmatic fills), so verify and fix the
   * quantities on the cart page deterministically. Any residue the retries
   * can't fix is still caught by the D14 summary diff before confirm.
   */
  private async reconcileCartQuantities(
    session: BrowserSession,
    work: WorkContext,
  ) {
    for (let round = 0; round < 3; round += 1) {
      await session.page.goto(tiendanube.cartUrl(work.store.domain));
      await this.dismissOverlays(session);
      await session.page.waitForTimeout(1000);
      const rows = await session.page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "input[type=number], input[name*=quantity], input[name*=cantidad]",
          ),
        ].map((input, index) => {
          // Climb until an ancestor carries real text (the immediate
          // wrappers around qty inputs are often empty flex shells).
          let node = input.parentElement;
          let text = "";
          for (let depth = 0; depth < 6 && node; depth += 1) {
            text = (node.textContent ?? "").trim();
            if (text.length > 20) break;
            node = node.parentElement;
          }
          return {
            index,
            value: Number((input as HTMLInputElement).value),
            rowText: text.toLowerCase().slice(0, 200),
          };
        }),
      );
      const fixes: Array<{ index: number; qty: number }> = [];
      const matchedRowIndexes = new Set<number>();
      const unmatchedLines: typeof work.cart.lines = [];
      for (const line of work.cart.lines) {
        const label = (
          line.store_item?.name ?? line.item_name
        ).toLowerCase();
        const row = rows.find(
          (r) => !matchedRowIndexes.has(r.index) && r.rowText.includes(label),
        );
        if (!row) {
          unmatchedLines.push(line);
          continue;
        }
        matchedRowIndexes.add(row.index);
        if (row.value !== line.qty) {
          fixes.push({ index: row.index, qty: line.qty });
        }
      }
      // Name matching can fail on themes that render names outside the row
      // container; when the leftover counts line up 1:1, pair by position.
      if (
        unmatchedLines.length > 0 &&
        rows.length === work.cart.lines.length
      ) {
        const leftoverRows = rows.filter(
          (r) => !matchedRowIndexes.has(r.index),
        );
        for (const [i, line] of unmatchedLines.entries()) {
          const row = leftoverRows[i];
          if (row && row.value !== line.qty) {
            fixes.push({ index: row.index, qty: line.qty });
          }
        }
      } else if (unmatchedLines.length > 0) {
        console.log(
          `[stagehand] could not match ${unmatchedLines.length} cart line(s) to qty inputs (${rows.length} inputs on page)`,
        );
      }
      if (fixes.length === 0) {
        console.log("[stagehand] cart quantities verified");
        return;
      }
      console.log(
        `[stagehand] adjusting cart quantities: ${JSON.stringify(fixes)}`,
      );
      for (const fix of fixes) {
        // Setting input.value doesn't persist (server state wins on reload);
        // Tienda Nube themes mutate quantity through LS.plusQuantity /
        // LS.minusQuantity (see the spinner onclick), which fire the AJAX
        // cart update. Fall back to clicking the spinner controls.
        const outcome = await session.page.evaluate(
          async (arg: { index: number; qty: number }) => {
            const inputs = [
              ...document.querySelectorAll(
                "input[type=number], input[name*=quantity], input[name*=cantidad]",
              ),
            ];
            const input = inputs[arg.index] as HTMLInputElement | undefined;
            if (!input) return "no-input";
            const itemId = Number(input.getAttribute("data-item-id"));
            const ls = (
              window as unknown as {
                LS?: {
                  plusQuantity?: (id: number) => void;
                  minusQuantity?: (id: number) => void;
                };
              }
            ).LS;
            let current = Number(input.value);
            for (let guard = 0; guard < 15 && current !== arg.qty; guard += 1) {
              if (current < arg.qty) {
                if (ls?.plusQuantity && itemId) ls.plusQuantity(itemId);
                else
                  (
                    input
                      .closest("[class*=row], tr")
                      ?.querySelector(
                        "[data-component='quantity.plus'], [class*=plus]",
                      ) as HTMLElement | null
                  )?.click();
              } else {
                if (ls?.minusQuantity && itemId) ls.minusQuantity(itemId);
                else
                  (
                    input
                      .closest("[class*=row], tr")
                      ?.querySelector(
                        "[data-component='quantity.minus'], [class*=minus]",
                      ) as HTMLElement | null
                  )?.click();
              }
              await new Promise((resolve) => setTimeout(resolve, 500));
              current = Number(
                (inputs[arg.index] as HTMLInputElement).value,
              );
            }
            return `qty-now-${current}`;
          },
          fix,
        );
        console.log(`[stagehand] quantity adjust outcome: ${outcome}`);
        await session.page.waitForTimeout(2500);
      }
    }
    console.log(
      "[stagehand] cart quantity reconciliation exhausted retries; the summary diff gate will flag any residue",
    );
  }

  private async checkoutToSummary(
    session: BrowserSession,
    job: PurchaseJobCtx,
  ) {
    const { work } = job;
    await session.page.goto(tiendanube.cartUrl(work.store.domain));
    await this.dismissOverlays(session);
    const runner = this.runner(session, work.store._id);
    await runner.runFlow("checkout_start", tiendanube.checkoutStartSteps());
    await this.selectSavedAddress(session, work);
    await runner.runFlow(
      "choose_shipping",
      tiendanube.chooseShippingSteps(work.store.shipping_preference),
    );
    const delivery = await this.resolveDeliveryDate(session, job);
    await runner.runFlow(
      "continue_to_payment",
      tiendanube.continueToPaymentSteps(),
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
    return { fill, delivery };
  }

  /**
   * Click the element whose surrounding text matches `needle` — first radios
   * (climbing to the text-bearing ancestor, same trick as the cart rows),
   * then clickable elements carrying the text themselves. Among matches the
   * one with the SHORTEST matching text wins: a list container holds every
   * option's text, so without this the first radio in DOM order would match
   * any needle (that is exactly how run 1 picked the wrong delivery date).
   */
  private async clickByText(
    session: BrowserSession,
    needle: string,
  ): Promise<string> {
    const result = await session.page.evaluate(
      (target: string) => {
        let bestRadio: HTMLElement | null = null;
        let bestRadioLen = 600;
        for (const radio of [
          ...document.querySelectorAll("input[type=radio]"),
        ]) {
          let node = (radio as HTMLElement).parentElement;
          for (let depth = 0; depth < 5 && node; depth += 1) {
            const text = (node.textContent ?? "")
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, "")
              .toLowerCase()
              .replace(/\s+/g, " ")
              .trim();
            if (text.includes(target)) {
              if (text.length < bestRadioLen) {
                bestRadioLen = text.length;
                bestRadio = radio as HTMLElement;
              }
              break; // closest matching ancestor found for this radio
            }
            node = node.parentElement;
          }
        }
        if (bestRadio) {
          bestRadio.click();
          return "radio";
        }
        let bestEl: HTMLElement | null = null;
        let bestElLen = 300;
        for (const el of [
          ...document.querySelectorAll("label, button, a, [role=button]"),
        ]) {
          const text = (el.textContent ?? "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
          if (
            text.includes(target) &&
            text.length < bestElLen &&
            (el as HTMLElement).offsetParent !== null
          ) {
            bestElLen = text.length;
            bestEl = el as HTMLElement;
          }
        }
        if (bestEl) {
          bestEl.click();
          return "element";
        }
        return "not-found";
      },
      normalizeForPageMatch(needle),
    );
    return typeof result === "string" ? result : "not-found";
  }

  /**
   * Select the household's saved checkout address by text match. Silent no-op
   * when the store has no configured address or the page shows no address
   * list (single-address accounts auto-select); the confirm-gate screenshot
   * remains the human check that the right address is on the order.
   */
  private async selectSavedAddress(session: BrowserSession, work: WorkContext) {
    const address = work.store.delivery_address;
    if (!address) return;
    const outcome = await this.clickByText(session, address);
    if (outcome === "not-found") {
      console.log(
        `[stagehand] saved address "${address}" not found on this step (single-address account or already selected); continuing`,
      );
      return;
    }
    console.log(`[stagehand] selected saved address via ${outcome}`);
    await session.page.waitForTimeout(1500);
  }

  /**
   * The date widget loads via AJAX after the shipping step renders; a cached
   * replay reaches this point much faster than the exploratory first run, so
   * an immediate extract sees no options (run 2 skipped the gate exactly this
   * way). Settle, extract, and retry before concluding there is no choice.
   */
  private async extractDeliveryOptions(session: BrowserSession) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await session.page.waitForTimeout(attempt === 0 ? 2000 : 3000);
      const extracted = await session.stagehand.extract(
        tiendanube.extractInstructions.deliveryOptions,
        tiendanube.deliveryOptionsSchema,
      );
      const options = extracted.options
        .map((option) => option.trim())
        .filter((option) => option.length > 0)
        .slice(0, MAX_DELIVERY_OPTIONS);
      if (options.length > 0) {
        return { options, selected: extracted.selected?.trim() };
      }
      console.log(
        `[stagehand] no delivery options visible yet (attempt ${attempt + 1}/3)`,
      );
    }
    return { options: [] as string[], selected: undefined };
  }

  private deliveryMatches(a: string | undefined, b: string | undefined) {
    if (!a || !b) return false;
    const left = normalizeForPageMatch(a);
    const right = normalizeForPageMatch(b);
    return (
      left.length > 0 &&
      right.length > 0 &&
      (left.includes(right) || right.includes(left))
    );
  }

  /** Ask the page which option is selected now; the click must have taken. */
  private async verifyDeliverySelected(
    session: BrowserSession,
    chosen: string,
  ): Promise<boolean> {
    const check = await session.stagehand.extract(
      "Which delivery date/window option is currently selected/checked on this checkout step? Also list all offered options.",
      tiendanube.deliveryOptionsSchema,
    );
    return this.deliveryMatches(check.selected, chosen);
  }

  /**
   * The delivery-date gate. Extract the offered dates, park the job as
   * awaiting_delivery_choice for a human pick (Telegram/dashboard), default
   * to the earliest option if nobody answers in time, then select the chosen
   * option on the page and VERIFY the widget registered it (run 1 clicked a
   * matching but inert element and the store silently kept its default). On
   * a captcha-resume rerun the stored choice is reused without re-asking.
   * Returns the choice and a human-facing warning when verification failed.
   */
  private async resolveDeliveryDate(
    session: BrowserSession,
    job: PurchaseJobCtx,
  ): Promise<{ chosen?: string; warning?: string }> {
    const freshJob = await this.options.convex.getJob(job.jobId);
    let chosen = freshJob?.chosen_delivery_option;
    let alreadySelected: string | undefined;

    if (!chosen) {
      const { options, selected } = await this.extractDeliveryOptions(session);
      alreadySelected = selected;
      if (options.length === 0) {
        console.log("[stagehand] no delivery date choice on this checkout");
        return {};
      }
      if (options.length === 1) {
        chosen = options[0]!;
      } else {
        console.log(
          `[stagehand] delivery options: ${options.join(" | ")}; awaiting human choice`,
        );
        await this.options.convex.awaitDeliveryChoice(job.jobId, options);
        let decision: JobDoc | null = null;
        try {
          decision = await this.options.convex.waitForJob(
            job.jobId,
            (doc) => doc === null || doc.status !== "awaiting_delivery_choice",
            DELIVERY_CHOICE_WAIT_MS,
          );
        } catch {
          // Nobody answered inside the worker's window; default to earliest.
        }
        if (!decision || decision.status === "awaiting_delivery_choice") {
          await this.options.convex.resumeDeliveryDefault(
            job.jobId,
            options[0]!,
          );
          decision = await this.options.convex.getJob(job.jobId);
        }
        if (decision?.status !== "running" || !decision.chosen_delivery_option) {
          throw new Error(
            `Job left the delivery gate as "${decision?.status ?? "missing"}"; aborting this run`,
          );
        }
        chosen = decision.chosen_delivery_option;
      }
    }

    if (this.deliveryMatches(alreadySelected, chosen)) {
      console.log(`[stagehand] delivery option already selected: ${chosen}`);
      return { chosen };
    }

    const outcome = await this.clickByText(session, chosen);
    console.log(
      `[stagehand] delivery option click for "${chosen}": ${outcome}`,
    );
    await session.page.waitForTimeout(2000);
    if (await this.verifyDeliverySelected(session, chosen)) {
      console.log(`[stagehand] verified delivery option: ${chosen}`);
      return { chosen };
    }

    console.log(
      `[stagehand] "${chosen}" not registered after deterministic click; falling back to LLM act`,
    );
    await actOrThrow(
      session.stagehand,
      tiendanube.selectDeliveryOptionInstruction(chosen),
    );
    await session.page.waitForTimeout(2000);
    if (await this.verifyDeliverySelected(session, chosen)) {
      console.log(`[stagehand] verified delivery option after heal: ${chosen}`);
      return { chosen };
    }

    return {
      chosen,
      warning: `Could not verify that the chosen delivery date ("${chosen}") registered on the store page — check the delivery date on the summary before confirming.`,
    };
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
