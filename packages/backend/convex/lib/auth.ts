import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx | ActionCtx;

export async function requireUser(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    return identity.subject;
  }

  // Local anonymous Convex development has no Clerk issuer configured. Once
  // Clerk is wired in deployment config, unauthenticated access is rejected.
  if (!process.env.CLERK_JWT_ISSUER_DOMAIN) {
    return "local-dev-user";
  }

  throw new ConvexError("Authentication required");
}

export function requireWorkerToken(args: { workerToken: string }) {
  const expected = process.env.WORKER_TOKEN;
  if (!expected || args.workerToken !== expected) {
    throw new ConvexError("Invalid worker token");
  }
}

export function requireBotToken(args: { botToken: string }) {
  const expected = process.env.BOT_CONVEX_TOKEN ?? process.env.WORKER_TOKEN;
  if (expected) {
    if (args.botToken !== expected) {
      throw new ConvexError("Invalid bot token");
    }
    return;
  }

  if (!process.env.CLERK_JWT_ISSUER_DOMAIN) {
    return;
  }

  throw new ConvexError("Bot token is not configured");
}
