import type { StagehandPage } from "./browser";
import type { WorkerSecrets } from "./secrets";
import { evaluateInCdpTarget, listCdpTargets } from "./cdp";

/**
 * Deterministic, worker-owned payment entry: card values are typed straight
 * into the page (and, when the form lives in a cross-origin gateway iframe,
 * into that iframe's own CDP target) and never appear in an LLM instruction,
 * transcript, or Convex document.
 *
 * Ground truth for Tienda Nube (inspected live, 2026-07-11): the card form is
 * served by checkout-security.ms.tiendanube.com in a cross-origin iframe with
 * fields named payment.creditCard.{cardNumber,cardHolderName,cardExpiration,
 * cardCvv,cardHolderIdNumber} — reachable only via its own CDP target.
 */

const CARD_FIELD_SELECTORS: Record<string, string[]> = {
  number: [
    "input[name*='cardNumber' i]",
    "input[id*='cardNumber' i]",
    "input[name*='card_number' i]",
    "input[autocomplete='cc-number']",
  ],
  holder: [
    "input[name*='cardHolderName' i]",
    "input[name*='holder' i]:not([name*='Id' i])",
    "input[name*='cardName' i]",
    "input[autocomplete='cc-name']",
  ],
  expiry: [
    "input[name*='expir' i]",
    "input[name*='cardExpiration' i]",
    "input[autocomplete='cc-exp']",
  ],
  cvv: [
    "input[name*='cvv' i]",
    "input[name*='securityCode' i]",
    "input[name*='cvc' i]",
    "input[autocomplete='cc-csc']",
  ],
  holderId: [
    "input[name*='cardHolderIdNumber' i]",
    "input[autocomplete='card_holder_id_number']",
  ],
};

const GATEWAY_FRAME_PATTERN =
  /checkout-security\.ms\.tiendanube\.com|nuvempay|mercadopago|decidir|payway/i;

export type PaymentFillResult = {
  attempted: boolean;
  filledFields: string[];
  /** A card input was found somewhere the worker can reach. */
  cardFieldSeen: boolean;
  /** An unreachable (cross-origin) iframe that looks like a payment gateway. */
  crossOriginPaymentFrame: boolean;
};

const NO_FILL: PaymentFillResult = {
  attempted: false,
  filledFields: [],
  cardFieldSeen: false,
  crossOriginPaymentFrame: false,
};

/** The Tienda Nube form wants MM/AA; tolerate MM/YYYY in the secrets file. */
function normalizeExpiry(expiry: string) {
  const match = expiry.match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!match) return expiry;
  const month = match[1]!.padStart(2, "0");
  const year = match[2]!.length === 4 ? match[2]!.slice(2) : match[2]!;
  return `${month}/${year}`;
}

type FieldSpec = { field: string; selectors: string[]; value: string };

function fieldSpecs(
  card: WorkerSecrets["payments"][string],
): FieldSpec[] {
  const values: Record<string, string | undefined> = {
    number: card.number,
    holder: card.holder,
    expiry: normalizeExpiry(card.expiry),
    cvv: card.cvv,
    holderId: card.holderId,
  };
  return Object.entries(CARD_FIELD_SELECTORS).flatMap(([field, selectors]) => {
    const value = values[field];
    return value ? [{ field, selectors, value }] : [];
  });
}

/**
 * Self-contained fill routine, stringified into both page.evaluate and raw
 * CDP Runtime.evaluate. Uses the native value setter + input/change events so
 * framework-controlled inputs accept the value; skips fields that already
 * hold one (e.g. a pre-filled DNI). Returns filled/seen per document.
 */
function buildFillExpression(specs: FieldSpec[]) {
  return `(() => {
    const specs = ${JSON.stringify(specs)};
    const filled = [];
    let seen = false;
    for (const spec of specs) {
      let input = null;
      for (const selector of spec.selectors) {
        input = document.querySelector(selector);
        if (input) break;
      }
      if (!input) continue;
      seen = true;
      if ((input.value || "").length > 0 && spec.field !== "number") {
        filled.push(spec.field);
        continue;
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, spec.value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      if ((input.value || "").length > 0) filled.push(spec.field);
    }
    return { filled, seen };
  })()`;
}

type FillOutcome = { filled: string[]; seen: boolean };

function asFillOutcome(value: unknown): FillOutcome {
  if (value && typeof value === "object" && Array.isArray((value as FillOutcome).filled)) {
    return value as FillOutcome;
  }
  return { filled: [], seen: false };
}

/**
 * On a fresh checkout session the payment methods render as a collapsed
 * accordion and the card inputs do not exist until "Tarjeta de crédito o
 * débito" is clicked (verified live 2026-07-12: only hidden method radios
 * were present, and clicking the label made payment.creditCard.* appear).
 * Returns "present" | "expanded" | "absent".
 */
const EXPAND_CARD_EXPRESSION = `(() => {
  if (document.querySelector("input[name*='cardNumber' i], input[autocomplete='cc-number']")) {
    return "present";
  }
  const candidates = [];
  for (const el of document.querySelectorAll("label, [class*=option], [class*=method], [class*=panel], h4, h5, div, span")) {
    if (el.offsetParent === null) continue;
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (/^tarjeta de cr(e|\\u00e9)dito o d(e|\\u00e9)bito$/i.test(text)) candidates.push(el);
  }
  if (candidates.length === 0) return "absent";
  candidates[candidates.length - 1].click();
  return "expanded";
})()`;

export async function fillPaymentIfPresent(
  page: StagehandPage,
  cdpEndpoint: string,
  secrets: WorkerSecrets,
  paymentRef: string | undefined,
): Promise<PaymentFillResult> {
  if (!paymentRef) return NO_FILL;
  const card = secrets.payments[paymentRef];
  if (!card) return NO_FILL;

  const specs = fieldSpecs(card);
  const expression = buildFillExpression(specs);

  // 1. Main document + detect gateway iframes.
  const main = asFillOutcome(await page.evaluate(expression));
  const filled = new Set(main.filled);
  let seen = main.seen;
  let crossOriginPaymentFrame = false;

  // 2. Gateway iframes are separate CDP targets; fill each directly.
  if (!filled.has("number")) {
    try {
      const targets = await listCdpTargets(cdpEndpoint);
      const frames = targets.filter(
        (target) =>
          target.type === "iframe" &&
          GATEWAY_FRAME_PATTERN.test(target.url) &&
          target.webSocketDebuggerUrl,
      );
      crossOriginPaymentFrame = frames.length > 0;
      for (const frame of frames) {
        // Expand the "Tarjeta de crédito o débito" accordion first when the
        // card inputs are not rendered yet, and give them time to appear.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const cardState = String(
            await evaluateInCdpTarget(
              frame.webSocketDebuggerUrl!,
              EXPAND_CARD_EXPRESSION,
            ),
          );
          if (cardState === "present") break;
          if (cardState === "absent" && attempt > 0) break;
          console.log(
            `[payment] card section in ${new URL(frame.url).hostname}: ${cardState} (attempt ${attempt + 1}/3)`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        const outcome = asFillOutcome(
          await evaluateInCdpTarget(frame.webSocketDebuggerUrl!, expression),
        );
        outcome.filled.forEach((field) => filled.add(field));
        seen = seen || outcome.seen;
        if (filled.has("number")) break;
      }
    } catch (error) {
      console.log(
        `[payment] gateway-frame fill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    attempted: true,
    filledFields: [...filled],
    cardFieldSeen: seen,
    crossOriginPaymentFrame,
  };
}

/**
 * A human-facing warning when checkout demands card data the worker could not
 * enter; undefined when payment looks handled (or no card form exists at all,
 * e.g. pay-on-delivery or a saved card).
 */
export function paymentWarningFor(
  fill: PaymentFillResult,
): string | undefined {
  if (!fill.attempted) return undefined;
  if (fill.filledFields.includes("number")) return undefined;
  if (fill.crossOriginPaymentFrame || fill.cardFieldSeen) {
    return "The card form could not be auto-filled — enter the card over noVNC BEFORE confirming.";
  }
  return undefined;
}
