import { ConvexClient } from "convex/browser";

export type WorkerConvexArgs = {
  convexUrl: string;
  workerToken: string;
  workerId: string;
};

export class WorkerConvex {
  private readonly client: ConvexClient;
  private readonly workerToken: string;
  private readonly workerId: string;

  constructor(args: WorkerConvexArgs) {
    this.client = new ConvexClient(args.convexUrl);
    this.workerToken = args.workerToken;
    this.workerId = args.workerId;
  }

  onQueuedJobs(callback: (jobs: unknown[]) => void) {
    return (this.client as any).onUpdate(
      "jobs:getQueued",
      { workerToken: this.workerToken },
      callback,
    );
  }

  async claim(jobId: string) {
    return await (this.client as any).mutation("jobs:claim", {
      workerToken: this.workerToken,
      job_id: jobId,
      worker_id: this.workerId,
    });
  }

  async pauseLimit(jobId: string, error: string) {
    await (this.client as any).mutation("jobs:pauseLimit", {
      workerToken: this.workerToken,
      job_id: jobId,
      worker_id: this.workerId,
      error,
    });
  }

  async fail(jobId: string, error: string) {
    await (this.client as any).mutation("jobs:fail", {
      workerToken: this.workerToken,
      job_id: jobId,
      worker_id: this.workerId,
      error,
    });
  }

  close() {
    void this.client.close();
  }
}
