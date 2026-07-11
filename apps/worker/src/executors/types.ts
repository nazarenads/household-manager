import type { ReceiptResult, SummaryResult } from "@household/shared";
import type { Id } from "@household/backend/convex/_generated/dataModel";
import type { WorkContext } from "../convexClient";

export type PurchaseJobCtx = {
  jobId: Id<"purchase_jobs">;
  work: WorkContext;
};

export interface Executor {
  /** Build cart + drive checkout to the order summary. Browser stays open. */
  runToSummary(job: PurchaseJobCtx): Promise<SummaryResult>;
  /** Called only after human confirmation and startConfirming (D13). */
  confirmPurchase(job: PurchaseJobCtx): Promise<ReceiptResult>;
  /** Expiry / cancellation / failure cleanup. */
  abort(job: PurchaseJobCtx): Promise<void>;
}

export class ExecutorLimitError extends Error {
  retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ExecutorLimitError";
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/**
 * Checkout is blocked on something only a human can do over noVNC: a captcha,
 * a lost login session, or a payment form the deterministic filler could not
 * handle. Maps to the paused_captcha job state.
 */
export class HumanInterventionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanInterventionError";
  }
}

const LIMIT_ERROR_PATTERN =
  /usage limit|rate.?limit|429|retry.?after|overloaded|quota/i;

export function isLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error instanceof ExecutorLimitError ||
      LIMIT_ERROR_PATTERN.test(error.message))
  );
}
