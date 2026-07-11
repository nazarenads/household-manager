import type { ReceiptResult, SummaryResult } from "@household/shared";
import type { Id } from "@household/backend/convex/_generated/dataModel";
import type { BrowserManager, BrowserSession } from "../browser";
import type { JobDoc, WorkerConvex, WorkContext } from "../convexClient";
import type { WorkerSecrets } from "../secrets";
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

/**
 * Shipping rows share a long method prefix ("Envío KAY a domicilio CABA - ");
 * strip it (on a " - " boundary only) so gate buttons show just the dates.
 * Row matching is by substring, so the stripped labels still match the rows.
 */
function stripCommonPrefix(labels: string[]): string[] {
  if (labels.length < 2) return labels;
  let prefix = labels[0]!;
  for (const label of labels) {
    let i = 0;
    while (i < prefix.length && i < label.length && prefix[i] === label[i]) {
      i += 1;
    }
    prefix = prefix.slice(0, i);
  }
  const boundary = prefix.lastIndexOf(" - ");
  if (boundary < 5) return labels;
  const cut = boundary + 3;
  return labels.map((label) => label.slice(cut).trim() || label);
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
      // Card values can be cleared by the store during the confirm wait;
      // refresh the deterministic fill (page + gateway frames) right before
      // the single final click. Refuse to click with an empty card form.
      const fill = await fillPaymentIfPresent(
        session.page,
        session.cdpEndpoint,
        this.options.secrets,
        this.paymentRef(work),
      );
      if (
        fill.attempted &&
        (fill.cardFieldSeen || fill.crossOriginPaymentFrame) &&
        !fill.filledFields.includes("number")
      ) {
        throw new HumanInterventionError(
          "Card form is empty at confirm time and could not be auto-filled; complete it over noVNC",
        );
      }
      await this.clickFinalConfirm(session);
      const outcome = await this.awaitOrderOutcome(session, 40000);
      if (outcome === "unchanged") {
        // The page provably did not react (button still there, no spinner,
        // no error, same URL) — the one situation where a single retry click
        // cannot double-submit.
        console.log(
          "[stagehand] page unchanged after confirm click; retrying the click once",
        );
        await this.clickFinalConfirm(session);
        await this.awaitOrderOutcome(session, 60000);
      }
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

  /**
   * D13, deterministic: the final purchase click targets the visible submit
   * button by class/text — never an LLM resolution or a cached xpath. (A
   * cached absolute xpath from an older page layout once "clicked"
   * successfully without ever hitting the real button.)
   */
  private async clickFinalConfirm(session: BrowserSession) {
    const result = await session.page.evaluate(() => {
      const candidates: HTMLElement[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(
        "button, [class*=btn]",
      )) {
        if (el.offsetParent === null) continue;
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (/^(realizar pedido|confirmar compra|pagar ahora|comprar)$/i.test(text)) {
          candidates.push(el);
        }
      }
      const preferred =
        candidates.find((el) => `${el.className ?? ""}`.includes("btn-submit-step")) ??
        candidates[0];
      if (!preferred) return "not-found";
      preferred.click();
      return (preferred.textContent ?? "").replace(/\s+/g, " ").trim();
    });
    if (result === "not-found") {
      throw new Error(
        "Final purchase button not found on the page; nothing was clicked",
      );
    }
    console.log(`[stagehand] final confirm clicked: "${result}"`);
  }

  /**
   * Poll the page after the final click until it shows a confirmation, an
   * error, or provably nothing (button still visible and enabled, no spinner,
   * no error, still on checkout). "pending" states (button gone, spinner,
   * navigation in flight) keep polling until the deadline.
   */
  private async awaitOrderOutcome(
    session: BrowserSession,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastState = "pending";
    let unchangedStreak = 0;
    while (Date.now() < deadline) {
      await session.page.waitForTimeout(2000);
      let state: unknown = "pending";
      try {
        state = await session.page.evaluate(() => {
          const text = (document.body?.innerText ?? "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase();
          if (
            /gracias por tu compra|pedido (fue )?(realizado|confirmado|recibido)|orden (creada|confirmada|recibida)|compra (realizada|exitosa)/.test(text) ||
            !location.pathname.includes("/checkout")
          ) {
            return "confirmed";
          }
          for (const el of document.querySelectorAll<HTMLElement>(
            "[class*=alert-danger], [class*=alert-error], [class*=has-error], [role=alert]",
          )) {
            if (el.offsetParent === null) continue;
            const errText = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (errText.length > 3 && !/rango horario|correo no deseado/i.test(errText)) {
              return "error: " + errText.slice(0, 140);
            }
          }
          const spinner = [...document.querySelectorAll<HTMLElement>(
            "[class*=spinner], [class*=loading], [class*=processing]",
          )].some((el) => el.offsetParent !== null);
          if (spinner) return "pending";
          const button = [
            ...document.querySelectorAll<HTMLElement>("button, [class*=btn]"),
          ].find(
            (el) =>
              el.offsetParent !== null &&
              /^(realizar pedido|confirmar compra|pagar ahora|comprar)$/i.test(
                (el.textContent ?? "").replace(/\s+/g, " ").trim(),
              ),
          );
          return button ? "unchanged" : "pending";
        });
      } catch {
        // Navigation in flight can kill the evaluate; that is progress.
        state = "pending";
      }
      lastState = String(state);
      if (lastState === "confirmed" || lastState.startsWith("error:")) {
        console.log(`[stagehand] order outcome: ${lastState}`);
        return lastState;
      }
      // Only declare "unchanged" after four consecutive quiet polls (~8s) —
      // a slow submit can look unchanged for a beat before reacting.
      unchangedStreak = lastState === "unchanged" ? unchangedStreak + 1 : 0;
      if (unchangedStreak >= 4) {
        console.log("[stagehand] order outcome: page provably unchanged");
        return "unchanged";
      }
    }
    console.log(`[stagehand] order outcome after timeout: ${lastState}`);
    return lastState;
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
    // From here to the human confirm gate everything is deterministic —
    // checkout pages carry the final 'Realizar pedido' button and no LLM
    // click is allowed anywhere near it (D3/D13).
    await this.ensureOnReviewPage(session);
    await this.selectSavedAddress(session, work);
    const delivery = await this.resolveDeliveryDate(session, job);
    const fill = await fillPaymentIfPresent(
      session.page,
      session.cdpEndpoint,
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
   * Advance from wherever checkout starts (usually 'Datos personales') to the
   * review page ('Envío y pago') by clicking only buttons whose exact text is
   * "Continuar" / "Continuar para el pago" — a pattern that can never match
   * the final purchase button.
   */
  private async ensureOnReviewPage(session: BrowserSession) {
    let lastDiag = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await session.page.evaluate(() => {
        const sections = [...document.querySelectorAll("section, article")];
        const onReview = sections.some(
          (s) =>
            /cambiar/i.test((s as HTMLElement).innerText ?? "") &&
            /env[ií]o|entrega|retiro/i.test((s as HTMLElement).innerText ?? ""),
        );
        if (onReview) return { state: "review", diag: "" };
        const errors = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          "[class*=error], [class*=alert-danger], [role=alert], [class*=has-error]",
        )) {
          if (el.offsetParent === null) continue;
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (text.length > 3) errors.push(text.slice(0, 100));
        }
        const heading = (
          document.querySelector("h1, h2, h3, legend")?.textContent ?? ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const diag = `url=${location.pathname.slice(0, 60)} heading="${heading.slice(0, 60)}" errors=${JSON.stringify(errors.slice(0, 3))}`;
        const continueButton = [
          ...document.querySelectorAll("button, [class*=btn]"),
        ].find(
          (el) =>
            (el as HTMLElement).offsetParent !== null &&
            /^continuar( para el pago)?$/i.test(
              (el.textContent ?? "").replace(/\s+/g, " ").trim(),
            ),
        );
        if (continueButton) {
          (continueButton as HTMLElement).click();
          return { state: "clicked-continue", diag };
        }
        return { state: "waiting", diag };
      });
      const result = state as { state: string; diag: string };
      if (result.state === "review") return;
      lastDiag = result.diag;
      console.log(
        `[stagehand] advancing to review page: ${result.state} | ${result.diag}`,
      );
      await session.page.waitForTimeout(2500);
    }
    throw new Error(
      `Could not reach the checkout review page ('Envío y pago'); last state: ${lastDiag}`,
    );
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

  /**
   * Read the option rows of the Tienda Nube shipping panel, opening it first
   * when it is collapsed behind its "Cambiar" button. DOM ground truth
   * (inspected live 2026-07-11): rows are `.shipping-options-ship > div`
   * with an onclick handler; the selected one carries class "active"; names
   * live in `.shipping-method-item-name`. Retries because the panel content
   * renders via AJAX after the click.
   */
  private async getDeliveryRows(
    session: BrowserSession,
  ): Promise<Array<{ label: string; active: boolean }>> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await session.page.evaluate(() => {
        const rows = [...document.querySelectorAll(".shipping-options-ship > div")];
        if (rows.length > 0) {
          return rows.map((row) => ({
            label: (
              (row.querySelector(".shipping-method-item-name")?.textContent ??
                row.textContent) ??
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
            active: `${row.className ?? ""}`.includes("active"),
          }));
        }
        for (const section of [...document.querySelectorAll("section")]) {
          const text = (section as HTMLElement).innerText ?? "";
          if (!/env[ií]o|entrega|retiro|domicilio/i.test(text)) continue;
          const button = [...section.querySelectorAll("[class*=btn]")].find(
            (el) =>
              (el.textContent ?? "").trim().toLowerCase() === "cambiar" &&
              (el as HTMLElement).offsetParent !== null,
          );
          if (button) {
            (button as HTMLElement).click();
            return "opened-panel";
          }
        }
        return "no-panel";
      });
      if (Array.isArray(result)) {
        return result.filter((row) => row.label.length > 0);
      }
      console.log(`[stagehand] delivery panel: ${result} (attempt ${attempt + 1}/4)`);
      await session.page.waitForTimeout(2000);
    }
    return [];
  }

  /**
   * Click the chosen row, confirm it turns "active", commit with the panel's
   * "Guardar" button, and verify the collapsed section summary now shows the
   * choice — the store's own state, not our click, is what gets trusted.
   */
  private async commitDeliverySelection(
    session: BrowserSession,
    chosen: string,
  ): Promise<string> {
    const needle = normalizeForPageMatch(chosen);
    const clicked = await session.page.evaluate((target: string) => {
      const rows = [...document.querySelectorAll(".shipping-options-ship > div")];
      const row = rows.find((r) =>
        (r.textContent ?? "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .includes(target),
      );
      if (!row) return "row-not-found";
      (row as HTMLElement).click();
      return "clicked";
    }, needle);
    if (clicked !== "clicked") return String(clicked);
    await session.page.waitForTimeout(1200);

    const saved = await session.page.evaluate((target: string) => {
      const rows = [...document.querySelectorAll(".shipping-options-ship > div")];
      const row = rows.find((r) =>
        (r.textContent ?? "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .includes(target),
      );
      if (!row || !`${row.className ?? ""}`.includes("active")) {
        return "row-not-active";
      }
      const section = row.closest("section") ?? document;
      const save = [...section.querySelectorAll("[class*=btn]")].find(
        (el) => (el.textContent ?? "").trim().toLowerCase() === "guardar",
      );
      if (!save) return "no-guardar-button";
      (save as HTMLElement).click();
      return "saved";
    }, needle);
    if (saved !== "saved") return String(saved);
    await session.page.waitForTimeout(3000);

    return (await this.deliverySummaryShows(session, chosen))
      ? "ok"
      : "summary-mismatch";
  }

  /** The collapsed shipping section's summary line reflects the store state. */
  private async deliverySummaryShows(
    session: BrowserSession,
    chosen: string,
  ): Promise<boolean> {
    const needle = normalizeForPageMatch(chosen);
    const result = await session.page.evaluate((target: string) => {
      for (const section of [...document.querySelectorAll("section, article")]) {
        const text = ((section as HTMLElement).innerText ?? "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ");
        if (/envio|entrega|retiro|domicilio/.test(text) && text.includes(target)) {
          return true;
        }
      }
      return false;
    }, needle);
    return result === true;
  }

  /**
   * The delivery-date gate, fully deterministic against the Tienda Nube
   * checkout: read the panel rows, park the job as awaiting_delivery_choice
   * for a human pick (Telegram/dashboard), default to the earliest option if
   * nobody answers in time, then click the row, commit with "Guardar", and
   * verify the section summary shows the choice (the click alone only
   * highlights the row — Guardar is what commits; that missing commit is how
   * runs 1–3 all silently kept the store default). On a captcha-resume rerun
   * the stored choice is reused without re-asking.
   */
  private async resolveDeliveryDate(
    session: BrowserSession,
    job: PurchaseJobCtx,
  ): Promise<{ chosen?: string; warning?: string }> {
    const freshJob = await this.options.convex.getJob(job.jobId);
    let chosen = freshJob?.chosen_delivery_option;

    // Fast path (rerun after captcha/heal): store already shows the choice.
    if (chosen && (await this.deliverySummaryShows(session, chosen))) {
      console.log(`[stagehand] delivery already set: ${chosen}`);
      return { chosen };
    }

    const rows = await this.getDeliveryRows(session);
    if (rows.length === 0) {
      if (chosen) {
        return {
          chosen,
          warning: `Could not find the delivery options panel to select "${chosen}" — check the date on the summary before confirming.`,
        };
      }
      console.log(
        "[stagehand] no delivery options panel on this checkout; store default stands",
      );
      return {};
    }

    const options = stripCommonPrefix(rows.map((row) => row.label)).slice(
      0,
      MAX_DELIVERY_OPTIONS,
    );

    if (!chosen) {
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

    let outcome = await this.commitDeliverySelection(session, chosen);
    if (outcome !== "ok") {
      console.log(
        `[stagehand] delivery selection failed (${outcome}); reopening panel and retrying once`,
      );
      await this.getDeliveryRows(session); // reopens the panel if it collapsed
      outcome = await this.commitDeliverySelection(session, chosen);
    }
    if (outcome === "ok") {
      console.log(`[stagehand] delivery date committed and verified: ${chosen}`);
      return { chosen };
    }
    return {
      chosen,
      warning: `Could not verify that the chosen delivery date ("${chosen}") registered on the store page (${outcome}) — check the delivery date on the summary before confirming.`,
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
