import { ConvexError } from "convex/values";

export type CartStatus =
  | "proposed"
  | "approved"
  | "executing"
  | "awaiting_confirm"
  | "completed"
  | "failed"
  | "cancelled";

export type PurchaseJobStatus =
  | "queued"
  | "running"
  | "awaiting_delivery_choice"
  | "awaiting_confirm"
  | "confirmed"
  | "confirming"
  | "done"
  | "failed"
  | "paused_captcha"
  | "paused_limit"
  | "expired"
  | "needs_reconciliation";

const allowedCartTransitions: Record<CartStatus, readonly CartStatus[]> = {
  proposed: ["approved", "cancelled"],
  approved: ["executing", "cancelled"],
  executing: ["awaiting_confirm", "failed"],
  awaiting_confirm: ["completed", "failed", "approved"],
  completed: [],
  failed: ["approved"],
  cancelled: ["approved"],
};

const allowedJobTransitions: Record<
  PurchaseJobStatus,
  readonly PurchaseJobStatus[]
> = {
  queued: ["running", "failed"],
  running: [
    "awaiting_delivery_choice",
    "awaiting_confirm",
    "paused_captcha",
    "paused_limit",
    "failed",
    "queued",
  ],
  // Back to running on a human choice or the worker's auto-earliest fallback;
  // back to queued when the expiry cron reclaims a dead worker's job.
  awaiting_delivery_choice: ["running", "queued", "failed"],
  awaiting_confirm: ["confirmed", "expired", "failed"],
  confirmed: ["confirming", "failed"],
  confirming: ["done", "needs_reconciliation"],
  done: [],
  failed: ["queued"],
  paused_captcha: ["running", "failed", "done"],
  paused_limit: ["queued", "running", "failed"],
  expired: ["queued"],
  needs_reconciliation: ["done", "failed"],
};

function assertTransition<T extends string>(
  label: string,
  allowed: Record<T, readonly T[]>,
  from: T,
  to: T,
) {
  if (!allowed[from].includes(to)) {
    throw new ConvexError(`Illegal ${label} transition: ${from} -> ${to}`);
  }
}

export function assertCartTransition(from: CartStatus, to: CartStatus) {
  assertTransition("cart", allowedCartTransitions, from, to);
}

export function assertJobTransition(
  from: PurchaseJobStatus,
  to: PurchaseJobStatus,
) {
  assertTransition("job", allowedJobTransitions, from, to);
}
