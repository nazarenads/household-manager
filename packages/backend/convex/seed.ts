import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireWorkerToken } from "./lib/auth";

export const defaults = mutation({
  args: { workerToken: v.string() },
  handler: async (ctx, args) => {
    requireWorkerToken(args);

    const executorConfig = await ctx.db.query("executor_config").first();
    if (!executorConfig) {
      await ctx.db.insert("executor_config", {
        default_executor: "stagehand",
        explorer_executor: "stagehand",
        harness_cli: "claude-code",
        stagehand_model: "anthropic/claude-haiku-4-5",
        vps_region: "ar-buenos-aires",
        default_proxy_policy: "if_challenged",
        confirm_timeout_minutes: 30,
      });
    }

    const aiDefaults = [
      {
        tier: "parser" as const,
        provider: "anthropic",
        model: "claude-haiku-4-5",
      },
      {
        tier: "executor" as const,
        provider: "anthropic",
        model: "claude-haiku-4-5",
      },
      {
        tier: "explorer" as const,
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ];

    for (const config of aiDefaults) {
      const existing = await ctx.db
        .query("ai_config")
        .withIndex("by_tier", (q) => q.eq("tier", config.tier))
        .unique();
      if (!existing) {
        await ctx.db.insert("ai_config", config);
      }
    }
  },
});
