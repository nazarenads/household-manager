import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.cron(
  "nightly reorder scan",
  "0 6 * * *",
  internal.reorder.createNightlyProposals,
);
crons.interval(
  "expire stale purchase jobs",
  { minutes: 5 },
  internal.jobs.expireStale,
);

export default crons;
