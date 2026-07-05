export const cartStatuses = [
  "proposed",
  "approved",
  "executing",
  "awaiting_confirm",
  "completed",
  "failed",
  "cancelled",
] as const;

export type CartStatus = (typeof cartStatuses)[number];

export const purchaseJobStatuses = [
  "queued",
  "running",
  "awaiting_confirm",
  "confirmed",
  "confirming",
  "done",
  "failed",
  "paused_captcha",
  "paused_limit",
  "expired",
  "needs_reconciliation",
] as const;

export type PurchaseJobStatus = (typeof purchaseJobStatuses)[number];

export const allowedCartTransitions: Record<CartStatus, readonly CartStatus[]> =
  {
    proposed: ["approved", "cancelled"],
    approved: ["executing", "cancelled"],
    executing: ["awaiting_confirm", "failed"],
    awaiting_confirm: ["completed", "failed", "approved"],
    completed: [],
    failed: ["approved"],
    cancelled: ["approved"],
  };

export const allowedJobTransitions: Record<
  PurchaseJobStatus,
  readonly PurchaseJobStatus[]
> = {
  queued: ["running", "failed"],
  running: [
    "awaiting_confirm",
    "paused_captcha",
    "paused_limit",
    "failed",
    "queued",
  ],
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

export function canTransition<T extends string>(
  allowed: Record<T, readonly T[]>,
  from: T,
  to: T,
): boolean {
  return allowed[from].includes(to);
}
