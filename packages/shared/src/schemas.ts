import { z } from "zod";
import { cartStatuses, purchaseJobStatuses } from "./status.js";

export const currencySchema = z.literal("ARS");

export const executorSchema = z.enum(["stagehand", "harness"]);

export const cartLineSchema = z.object({
  itemId: z.string(),
  storeItemId: z.string().optional(),
  qty: z.number().positive(),
  expectedUnitPrice: z.number().nonnegative().optional(),
  note: z.string().optional(),
});

export const cartStatusSchema = z.enum(cartStatuses);
export const purchaseJobStatusSchema = z.enum(purchaseJobStatuses);

export const summaryLineStatusSchema = z.enum([
  "expected",
  "substituted",
  "unavailable",
  "extra",
]);

export const summaryLineItemSchema = z.object({
  itemId: z.string().optional(),
  storeItemId: z.string().optional(),
  name: z.string(),
  qty: z.number().nonnegative(),
  unitPrice: z.number().nonnegative().optional(),
  lineTotal: z.number().nonnegative().optional(),
  status: summaryLineStatusSchema,
});

export const summaryResultSchema = z.object({
  screenshotPath: z.string().optional(),
  total: z.number().nonnegative(),
  currency: currencySchema,
  lineItems: z.array(summaryLineItemSchema),
  shippingTotal: z.number().nonnegative().optional(),
  deliveryWindow: z.string().optional(),
  /** Set when the checkout demands card data the worker could not auto-fill. */
  paymentWarning: z.string().optional(),
  /** Set when the chosen delivery date could not be verified on the page. */
  deliveryWarning: z.string().optional(),
  redactionApplied: z.boolean(),
  diff: z
    .object({
      withinPolicy: z.boolean(),
      notes: z.array(z.string()),
    })
    .optional(),
});

export type SummaryResult = z.infer<typeof summaryResultSchema>;

export const receiptResultSchema = z.object({
  orderRef: z.string().optional(),
  receiptRef: z.string().optional(),
  total: z.number().nonnegative(),
  currency: currencySchema,
  lineItems: z.array(
    z.object({
      name: z.string(),
      qty: z.number().nonnegative(),
      price: z.number().nonnegative(),
    }),
  ),
});

export type ReceiptResult = z.infer<typeof receiptResultSchema>;

export const parserResultSchema = z.object({
  item: z.string(),
  delta: z.number(),
  confidence: z.number().min(0).max(1),
});

export type ParserResult = z.infer<typeof parserResultSchema>;
