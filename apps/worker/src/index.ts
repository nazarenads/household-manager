import { loadEnv } from "./config/env";
import { WorkerConvex } from "./convexClient";
import { ExecutorLimitError } from "./executors/types";

type QueueJob = {
  _id: string;
  cart_id: string;
  store_id: string;
  executor: "stagehand" | "harness";
};

async function run() {
  const env = loadEnv();
  const convex = new WorkerConvex({
    convexUrl: env.CONVEX_URL,
    workerToken: env.WORKER_TOKEN,
    workerId: env.WORKER_ID,
  });

  let busy = false;
  const processJobs = async (jobs: unknown[]) => {
    if (busy) return;
    const [job] = jobs as QueueJob[];
    if (!job) return;
    busy = true;
    try {
      const claimed = (await convex.claim(job._id)) as QueueJob | null;
      if (!claimed) return;
      throw new Error(
        "Executor training is not implemented yet; run Phase 1.5 and S2.0 first.",
      );
    } catch (error) {
      if (error instanceof ExecutorLimitError) {
        await convex.pauseLimit(job._id, error.message);
      } else {
        await convex.fail(
          job._id,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      busy = false;
    }
  };

  const unsubscribe = convex.onQueuedJobs((jobs) => {
    void processJobs(jobs);
  });

  process.on("SIGINT", () => {
    unsubscribe();
    convex.close();
    process.exit(0);
  });
}

void run();
