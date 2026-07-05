import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx | ActionCtx;

export async function requireUser(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Authentication required");
  }
  return identity.subject;
}

export function requireWorkerToken(args: { workerToken: string }) {
  const expected = process.env.WORKER_TOKEN;
  if (!expected || args.workerToken !== expected) {
    throw new ConvexError("Invalid worker token");
  }
}
