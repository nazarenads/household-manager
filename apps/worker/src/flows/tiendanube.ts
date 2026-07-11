import { z } from "zod";
import type { StepTemplate } from "../trajectory";

/**
 * Tienda Nube flow templates. These are the store-agnostic instruction
 * shapes the plan's TN-transfer hypothesis is about: the same templates run
 * at every Tienda Nube shop while each store builds its own cached action
 * objects. Volatile values (quantities, search terms) travel in `arguments`
 * so cached selectors replay unchanged across runs.
 */

export const captchaStateSchema = z.object({
  captchaVisible: z
    .boolean()
    .describe(
      "True if a captcha, robot check, or human-verification challenge is blocking the page",
    ),
  description: z.string().optional(),
});

export const summaryExtractSchema = z.object({
  total: z.number().describe("Order total in ARS, numbers only"),
  shippingTotal: z
    .number()
    .optional()
    .describe("Shipping cost in ARS if shown separately"),
  deliveryWindow: z
    .string()
    .optional()
    .describe("Delivery or pickup window as displayed"),
  lines: z.array(
    z.object({
      name: z.string().describe("Product name as displayed"),
      qty: z.number().describe("Quantity"),
      unitPrice: z.number().optional().describe("Unit price in ARS"),
      lineTotal: z.number().optional().describe("Line total in ARS"),
      availability: z
        .enum(["available", "substituted", "unavailable"])
        .describe(
          "available unless the page marks the item substituted or out of stock",
        ),
    }),
  ),
});

export type SummaryExtract = z.infer<typeof summaryExtractSchema>;

export const receiptExtractSchema = z.object({
  orderPlaced: z
    .boolean()
    .describe(
      "True ONLY if the page explicitly confirms the order was created (a thank-you/confirmation page, an order number, 'tu pedido fue realizado'). False if the page still shows a payment form, the checkout summary, validation errors, or anything ambiguous.",
    ),
  orderNumber: z
    .string()
    .optional()
    .describe("Order/confirmation number as displayed"),
  total: z.number().describe("Charged total in ARS"),
  lines: z.array(
    z.object({
      name: z.string(),
      qty: z.number(),
      price: z.number().describe("Line price in ARS"),
    }),
  ),
});

export type ReceiptExtract = z.infer<typeof receiptExtractSchema>;

export const deliveryOptionsSchema = z.object({
  options: z
    .array(z.string())
    .describe(
      "Every selectable delivery date/window option exactly as displayed, in chronological order (earliest first). Empty if the page offers no date choice.",
    ),
  selected: z
    .string()
    .optional()
    .describe("The option currently selected, if any is marked selected"),
});

export type DeliveryOptionsExtract = z.infer<typeof deliveryOptionsSchema>;

export const extractInstructions = {
  captchaState:
    "Determine whether a captcha or robot-verification challenge is currently blocking interaction with the page.",
  deliveryOptions:
    "List the delivery date or delivery window options the shipping step currently offers (calendar days, time slots, or labelled windows like 'Lunes 13/07'). Return them exactly as displayed, earliest first. Return an empty list if this step has no date/window choice.",
  summary:
    "Extract the order summary: every product line with name, quantity, unit price and line total, plus the shipping cost, the delivery window if shown, and the order total. Mark a line 'unavailable' if it is flagged out of stock, 'substituted' if the store replaced it.",
  receipt:
    "Determine whether this page explicitly confirms that an order was just placed (thank-you page, order number, 'tu pedido fue realizado'). Set orderPlaced accordingly — it is false if the page still shows a payment form, card-data fields, the checkout summary, or any validation error. Then extract the order/confirmation number and the final charged total, plus the purchased lines with name, quantity, and price.",
} as const;

// Tienda Nube's cart page lives at /comprar; /cart renders the 404 template.
export function cartUrl(domain: string) {
  return `https://${domain}/comprar`;
}

export function homeUrl(domain: string) {
  return `https://${domain}/`;
}

/**
 * Login state is checked by URL, not LLM judgment: Tienda Nube redirects
 * /account to /account/login when no customer session exists, and many themes
 * give the LLM nothing to distinguish (just a bare person icon either way).
 */
export function accountUrl(domain: string) {
  return `https://${domain}/account`;
}

export function isLoginUrl(url: string) {
  return url.includes("/account/login");
}

/** Add-to-cart from a product page reached deterministically via goto(). */
export function addToCartSteps(qty: number): StepTemplate[] {
  return [
    {
      key: "set-qty",
      instruction:
        "Set the product quantity input on this product page to the required amount",
      arguments: [String(qty)],
    },
    {
      key: "add-to-cart",
      instruction:
        "Click the add-to-cart button (usually labelled 'Agregar al carrito' or 'Comprar')",
    },
  ];
}

/** Add-to-cart via the store's search when no product URL is mapped. */
export function addToCartViaSearchSteps(
  searchTerm: string,
  qty: number,
): StepTemplate[] {
  return [
    {
      key: "open-search",
      instruction:
        "Click the search icon or search input in the site header to focus product search",
    },
    {
      key: "type-search",
      instruction: "Type the product search term into the search input",
      arguments: [searchTerm],
    },
    {
      key: "submit-search",
      instruction:
        "Submit the product search (press the search button or Enter)",
    },
    {
      key: "open-first-result",
      instruction: `Click the first product result that best matches "${searchTerm}"`,
    },
    ...addToCartSteps(qty),
  ];
}

/**
 * The cart-to-summary journey is split into three flows so worker-owned code
 * can run between them (saved-address selection, the delivery-date gate).
 * All of them stop BEFORE any final purchase/confirm button (D3: the human
 * checkpoint lives between these flows and the confirm flow).
 */
export function checkoutStartSteps(): StepTemplate[] {
  return [
    {
      key: "start-checkout",
      instruction:
        "Click the start-checkout button on the cart page (usually 'Iniciar compra' or 'Finalizar compra')",
    },
    {
      key: "confirm-contact",
      instruction:
        "The checkout shows a personal-data step ('Datos personales') with the customer's saved contact details. Click its continue button (usually 'Continuar'). If this step is not shown, click the continue button of whatever checkout step is visible.",
    },
  ];
}

export function chooseShippingSteps(shippingPreference: string): StepTemplate[] {
  return [
    {
      key: "choose-shipping",
      instruction: `Select the shipping/delivery option matching: ${shippingPreference}. If shipping is already selected and correct, click the continue button instead.`,
    },
  ];
}

export function continueToPaymentSteps(): StepTemplate[] {
  return [
    {
      key: "continue-to-payment",
      instruction:
        "Continue to the payment step (button usually labelled 'Continuar')",
    },
  ];
}

/**
 * LLM fallback when the deterministic text-match click can't find the chosen
 * delivery option. Not cached: the label is different every week.
 */
export function selectDeliveryOptionInstruction(option: string) {
  return `Select the delivery date/window option labelled "${option}" (click its radio button, card, or calendar day)`;
}

/** The single final click (D13): executed once, after startConfirming. */
export const confirmStep: StepTemplate = {
  key: "confirm-purchase",
  instruction:
    "Click the final purchase confirmation button (usually 'Confirmar compra' or 'Pagar ahora'). Click it exactly once.",
};
