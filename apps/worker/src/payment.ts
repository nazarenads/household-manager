import type { StagehandPage } from "./browser";
import type { WorkerSecrets } from "./secrets";

/**
 * Deterministic, worker-owned payment entry: card values are typed straight
 * into the page via CDP evaluate and never appear in an LLM instruction,
 * transcript, or Convex document. Best effort — payment widgets rendered in
 * cross-origin iframes cannot be reached this way and fall back to a human
 * over noVNC (the first runs per store are watched anyway).
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
};

export async function fillPaymentIfPresent(
  page: StagehandPage,
  secrets: WorkerSecrets,
  paymentRef: string | undefined,
): Promise<PaymentFillResult> {
  if (!paymentRef) return { attempted: false, filledFields: [] };
  const card = secrets.payments[paymentRef];
  if (!card) return { attempted: false, filledFields: [] };

  const values: Record<string, string> = {
    number: card.number,
    holder: card.holder,
    expiry: card.expiry,
    cvv: card.cvv,
  };

  const filledFields: string[] = [];
  for (const [field, selectors] of Object.entries(CARD_FIELD_SELECTORS)) {
    const filled = await page.evaluate(
      ({ selectors, value }: { selectors: string[]; value: string }) => {
        for (const selector of selectors) {
          const input = document.querySelector<HTMLInputElement>(selector);
          if (!input) continue;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      },
      { selectors, value: values[field]! },
    );
    if (filled) filledFields.push(field);
  }

  return { attempted: true, filledFields };
}
