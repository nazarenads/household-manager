import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { requireUser } from "./lib/auth";

const parserResultSchema = z.object({
  item: z.string(),
  delta: z.number(),
  confidence: z.number().min(0).max(1),
});

export const parseStockMessage = action({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const result = await generateObject({
      model: anthropic(process.env.PARSER_MODEL ?? "claude-haiku-4-5"),
      schema: parserResultSchema,
      prompt: [
        "Parse a household stock update into an item name and signed delta.",
        "Use negative deltas for consumption, positive deltas for additions.",
        `Message: ${args.text}`,
      ].join("\n"),
    });
    return result.object;
  },
});
