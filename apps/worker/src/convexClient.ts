import { ConvexClient } from "convex/browser";
import { api } from "@household/backend/convex/_generated/api";
import type { Doc, Id } from "@household/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";

export type WorkerConvexArgs = {
  convexUrl: string;
  workerToken: string;
  workerId: string;
};

export type JobDoc = Doc<"purchase_jobs">;
export type WorkContext = NonNullable<
  FunctionReturnType<typeof api.jobs.getWorkContext>
>;
export type TrajectoryDoc = Doc<"trajectories">;
export type TrajectoryStep = TrajectoryDoc["steps"][number];

export type SummaryPayload = {
  order_summary_screenshot?: Id<"_storage"> | undefined;
  order_summary_total: number;
  order_summary_currency: "ARS";
  summary_line_items: Array<{
    item_id?: Id<"items"> | undefined;
    store_item_id?: Id<"store_items"> | undefined;
    name: string;
    qty: number;
    unit_price?: number | undefined;
    line_total?: number | undefined;
    status: "expected" | "substituted" | "unavailable" | "extra";
  }>;
  summary_shipping_total?: number | undefined;
  summary_delivery_window?: string | undefined;
  summary_payment_warning?: string | undefined;
};

export type ReceiptPayload = {
  order_ref?: string | undefined;
  receipt_ref?: string | undefined;
  total: number;
  currency: "ARS";
  line_items: Array<{ name: string; qty: number; price: number }>;
};

/** Strip explicit-undefined members (exactOptionalPropertyTypes bridge). */
function compact<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], undefined> };
}

export class WorkerConvex {
  private readonly client: ConvexClient;
  private readonly workerToken: string;
  private readonly workerId: string;

  constructor(args: WorkerConvexArgs) {
    this.client = new ConvexClient(args.convexUrl);
    this.workerToken = args.workerToken;
    this.workerId = args.workerId;
  }

  private ids(jobId: Id<"purchase_jobs">) {
    return {
      workerToken: this.workerToken,
      job_id: jobId,
      worker_id: this.workerId,
    };
  }

  /**
   * Resolve a CLI store argument (Convex _id, login_ref, or name) to the
   * store _id — the key persistent browser profiles live under. Logging in
   * under any other key would authenticate a profile real jobs never open.
   */
  async resolveStore(
    ref: string,
  ): Promise<{ _id: Id<"stores">; name: string; domain: string }> {
    const stores = await this.client.query(api.stores.listForWorker, {
      workerToken: this.workerToken,
    });
    const needle = ref.trim().toLowerCase();
    const match = stores.find(
      (store) =>
        store._id === ref ||
        store.login_ref.toLowerCase() === needle ||
        store.name.toLowerCase() === needle,
    );
    if (match) return match;
    const listing = stores
      .map((store) => `  ${store._id}  ${store.login_ref}  (${store.name})`)
      .join("\n");
    throw new Error(
      `No active store matches "${ref}". Use the store id or login_ref:\n${listing}`,
    );
  }

  onQueuedJobs(callback: (jobs: JobDoc[]) => void): () => void {
    return this.client.onUpdate(
      api.jobs.getQueued,
      { workerToken: this.workerToken },
      callback,
    );
  }

  async getJob(jobId: Id<"purchase_jobs">): Promise<JobDoc | null> {
    return await this.client.query(api.jobs.getForWorker, {
      workerToken: this.workerToken,
      job_id: jobId,
    });
  }

  onJob(
    jobId: Id<"purchase_jobs">,
    callback: (job: JobDoc | null) => void,
  ): () => void {
    return this.client.onUpdate(
      api.jobs.getForWorker,
      { workerToken: this.workerToken, job_id: jobId },
      callback,
    );
  }

  /**
   * Resolve when the job document satisfies the predicate. Rejects on timeout
   * so a dead subscription can never park the worker forever.
   */
  waitForJob(
    jobId: Id<"purchase_jobs">,
    predicate: (job: JobDoc | null) => boolean,
    timeoutMs: number,
  ): Promise<JobDoc | null> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const unsubscribe = this.onJob(jobId, (job) => {
        if (settled) return;
        if (predicate(job)) {
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(job);
        }
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new Error(`Timed out waiting on job ${jobId}`));
      }, timeoutMs);
    });
  }

  async getExecutorConfig(): Promise<Doc<"executor_config"> | null> {
    return await this.client.query(api.config.getForWorker, {
      workerToken: this.workerToken,
    });
  }

  async getWorkContext(
    jobId: Id<"purchase_jobs">,
  ): Promise<WorkContext | null> {
    return await this.client.query(api.jobs.getWorkContext, {
      workerToken: this.workerToken,
      job_id: jobId,
    });
  }

  async claim(jobId: Id<"purchase_jobs">): Promise<JobDoc | null> {
    return await this.client.mutation(api.jobs.claim, this.ids(jobId));
  }

  async renewLease(jobId: Id<"purchase_jobs">) {
    await this.client.mutation(api.jobs.renewLease, this.ids(jobId));
  }

  async awaitDeliveryChoice(
    jobId: Id<"purchase_jobs">,
    deliveryOptions: string[],
  ) {
    await this.client.mutation(api.jobs.awaitDeliveryChoice, {
      ...this.ids(jobId),
      delivery_options: deliveryOptions,
    });
  }

  async resumeDeliveryDefault(jobId: Id<"purchase_jobs">, option: string) {
    await this.client.mutation(api.jobs.resumeDeliveryDefault, {
      ...this.ids(jobId),
      option,
    });
  }

  async reachedSummary(jobId: Id<"purchase_jobs">, payload: SummaryPayload) {
    await this.client.mutation(
      api.jobs.reachedSummary,
      compact({
        ...this.ids(jobId),
        ...payload,
        summary_line_items: payload.summary_line_items.map((line) =>
          compact(line),
        ),
      }),
    );
  }

  async startConfirming(jobId: Id<"purchase_jobs">) {
    await this.client.mutation(api.jobs.startConfirming, this.ids(jobId));
  }

  async complete(jobId: Id<"purchase_jobs">, receipt: ReceiptPayload) {
    await this.client.mutation(
      api.jobs.complete,
      compact({ ...this.ids(jobId), ...receipt }),
    );
  }

  async pauseCaptcha(jobId: Id<"purchase_jobs">, error?: string) {
    await this.client.mutation(
      api.jobs.pauseCaptcha,
      compact({ ...this.ids(jobId), error }),
    );
  }

  async pauseLimit(
    jobId: Id<"purchase_jobs">,
    error?: string,
    retryAfterMs?: number,
  ) {
    await this.client.mutation(
      api.jobs.pauseLimit,
      compact({ ...this.ids(jobId), error, retry_after_ms: retryAfterMs }),
    );
  }

  async markNeedsReconciliation(jobId: Id<"purchase_jobs">, error?: string) {
    await this.client.mutation(
      api.jobs.markNeedsReconciliation,
      compact({ ...this.ids(jobId), error }),
    );
  }

  async fail(jobId: Id<"purchase_jobs">, error: string) {
    await this.client.mutation(api.jobs.fail, { ...this.ids(jobId), error });
  }

  async uploadScreenshot(bytes: Uint8Array): Promise<Id<"_storage">> {
    const uploadUrl = await this.client.mutation(api.jobs.generateUploadUrl, {
      workerToken: this.workerToken,
    });
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`Screenshot upload failed: HTTP ${response.status}`);
    }
    const { storageId } = (await response.json()) as {
      storageId: Id<"_storage">;
    };
    return storageId;
  }

  async getTrajectory(
    storeId: Id<"stores">,
    flow: string,
  ): Promise<TrajectoryDoc | null> {
    return await this.client.query(api.trajectories.getForStoreFlow, {
      workerToken: this.workerToken,
      store_id: storeId,
      flow,
    });
  }

  async saveTrajectory(
    storeId: Id<"stores">,
    flow: string,
    steps: TrajectoryStep[],
  ) {
    await this.client.mutation(api.trajectories.save, {
      workerToken: this.workerToken,
      store_id: storeId,
      flow,
      steps,
    });
  }

  async recordTrajectoryOutcome(
    trajectoryId: Id<"trajectories">,
    success: boolean,
  ) {
    await this.client.mutation(api.trajectories.recordOutcome, {
      workerToken: this.workerToken,
      trajectory_id: trajectoryId,
      success,
    });
  }

  close() {
    void this.client.close();
  }
}
