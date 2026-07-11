import type { StagehandPage } from "./browser";
import type { WorkerSecrets } from "./secrets";

/**
 * Deterministic, worker-owned payment entry: card values are typed straight
 * into the page via CDP evaluate and never appear in an LLM instruction,
 * transcript, or Convex document. Reaches the main document and same-origin
 * iframes. Cross-origin gateway iframes (Pago Nube / Mercado Pago bricks and
 * friends) cannot be reached this way — they are *detected* and reported so
 * the confirm gate can tell the human to fill the card over noVNC first.
 */

const CARD_FIELD_SELECTORS: Record<string, string[]> = {
  number: [
    "input[name*='cardNumber' i]",
    "input[id*='cardNumber' i]",
    "input[name*='card_number' i]",
    "input[autocomplete='cc-number']",
  ],
  holder: [
    "input[name*='holder' i]",
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
};

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

export async function fillPaymentIfPresent(
  page: StagehandPage,
  secrets: WorkerSecrets,
  paymentRef: string | undefined,
): Promise<PaymentFillResult> {
  if (!paymentRef) return NO_FILL;
  const card = secrets.payments[paymentRef];
  if (!card) return NO_FILL;

  const fields = Object.entries(CARD_FIELD_SELECTORS).map(
    ([field, selectors]) => ({
      field,
      selectors,
      value:
        field === "number"
          ? card.number
          : field === "holder"
            ? card.holder
            : field === "expiry"
              ? card.expiry
              : card.cvv,
    }),
  );

  const outcome = await page.evaluate(
    (arg: {
      fields: Array<{ field: string; selectors: string[]; value: string }>;
    }) => {
      const docs: Document[] = [document];
      let crossOrigin = false;
      for (const frame of [...document.querySelectorAll("iframe")]) {
        let doc: Document | null = null;
        try {
          doc = (frame as HTMLIFrameElement).contentDocument;
        } catch {
          doc = null;
        }
        if (doc) {
          docs.push(doc);
        } else if (
          /pago|payment|card|tarjeta|mercado|checkout|secure|brick/i.test(
            `${(frame as HTMLIFrameElement).src} ${(frame as HTMLIFrameElement).id} ${(frame as HTMLIFrameElement).name}`,
          )
        ) {
          crossOrigin = true;
        }
      }
      const filled: string[] = [];
      let seen = false;
      for (const spec of arg.fields) {
        for (const doc of docs) {
          let input: HTMLInputElement | null = null;
          for (const selector of spec.selectors) {
            input = doc.querySelector<HTMLInputElement>(selector);
            if (input) break;
          }
          if (!input) continue;
          seen = true;
          const view = doc.defaultView ?? window;
          const setter = Object.getOwnPropertyDescriptor(
            view.HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(input, spec.value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          filled.push(spec.field);
          break;
        }
      }
      return { filled, seen, crossOrigin };
    },
    { fields },
  );

  const result =
    outcome && typeof outcome === "object"
      ? (outcome as { filled: string[]; seen: boolean; crossOrigin: boolean })
      : { filled: [], seen: false, crossOrigin: false };
  return {
    attempted: true,
    filledFields: result.filled,
    cardFieldSeen: result.seen,
    crossOriginPaymentFrame: result.crossOrigin,
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
  if (fill.crossOriginPaymentFrame) {
    return "Card form is inside a payment-gateway iframe the worker cannot fill — enter the card over noVNC BEFORE confirming.";
  }
  if (fill.cardFieldSeen) {
    return "A card form is visible but the card number was not auto-filled — check it over noVNC BEFORE confirming.";
  }
  return undefined;
}
