import type { Executor, PurchaseJobCtx } from "./types";
import type { ReceiptResult, SummaryResult } from "@household/shared";

export class StagehandExecutor implements Executor {
  async runToSummary(job: PurchaseJobCtx): Promise<SummaryResult> {
    throw new Error(
      `Stagehand runToSummary is not trained yet for store ${job.storeId}`,
    );
  }

  async confirmPurchase(job: PurchaseJobCtx): Promise<ReceiptResult> {
    throw new Error(
      `Stagehand confirmPurchase is not trained yet for job ${job.jobId}`,
    );
  }

  async abort(_job: PurchaseJobCtx): Promise<void> {
    return;
  }
}
