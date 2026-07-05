import type { ReceiptResult, SummaryResult } from "@household/shared";

export type PurchaseJobCtx = {
  jobId: string;
  cartId: string;
  storeId: string;
  executor: "stagehand" | "harness";
};

export interface Executor {
  runToSummary(job: PurchaseJobCtx): Promise<SummaryResult>;
  confirmPurchase(job: PurchaseJobCtx): Promise<ReceiptResult>;
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
