import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type ExecutorKind = "stagehand" | "harness";

/**
 * Executor routing, resolved at job creation (Phase 4):
 * explicit request > per-store override > explorer tier for first contact
 * (no trajectories recorded yet) > configured default.
 */
export async function resolveExecutor(
  ctx: MutationCtx,
  store: Doc<"stores"> | null,
  storeId: Id<"stores">,
  explicit?: ExecutorKind,
): Promise<ExecutorKind> {
  if (explicit) return explicit;
  if (store?.executor_override) return store.executor_override;

  const config = await ctx.db.query("executor_config").first();
  const hasTrajectories =
    (await ctx.db
      .query("trajectories")
      .withIndex("by_store_flow", (q) => q.eq("store_id", storeId))
      .first()) !== null;
  if (!hasTrajectories && config?.explorer_executor) {
    return config.explorer_executor;
  }
  return config?.default_executor ?? "stagehand";
}
