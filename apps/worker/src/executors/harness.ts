import { execa } from "execa";
import {
  receiptResultSchema,
  summaryResultSchema,
  type ReceiptResult,
  type SummaryResult,
} from "@household/shared";
import {
  ExecutorLimitError,
  type Executor,
  type PurchaseJobCtx,
} from "./types";

type HarnessOptions = {
  mcpConfigPath: string;
  cli?: "claude" | "codex";
  maxTurns?: number;
};

const SAFE_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "LANG",
  "LC_ALL",
]);

function safeEnv() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && SAFE_ENV_KEYS.has(key)) env[key] = value;
  }
  return env;
}

function parseHarnessOutput(output: string) {
  try {
    return JSON.parse(output);
  } catch {
    const match = output.match(/\{[\s\S]*\}$/);
    if (!match) throw new Error("Harness did not return JSON");
    return JSON.parse(match[0]);
  }
}

export class HarnessExecutor implements Executor {
  private readonly options: Required<HarnessOptions>;

  constructor(options: HarnessOptions) {
    this.options = {
      cli: options.cli ?? "claude",
      maxTurns: options.maxTurns ?? 12,
      mcpConfigPath: options.mcpConfigPath,
    };
  }

  async runToSummary(job: PurchaseJobCtx): Promise<SummaryResult> {
    const prompt = [
      "You are controlling a browser for a private household purchase workflow.",
      "Stop at the order summary. Do not click the final purchase/confirm button.",
      "Return only JSON matching the provided schema.",
      `Job: ${job.jobId}`,
      `Store: ${job.storeId}`,
    ].join("\n");
    const parsed = await this.runClaude(prompt, "SummaryResultSchema");
    return summaryResultSchema.parse(parsed);
  }

  async confirmPurchase(job: PurchaseJobCtx): Promise<ReceiptResult> {
    const prompt = [
      "The order summary is on screen.",
      "Click the final purchase/confirm button exactly once.",
      "Return only JSON with the order reference, total, and receipt line items.",
      `Job: ${job.jobId}`,
    ].join("\n");
    const parsed = await this.runClaude(prompt, "ReceiptResultSchema");
    return receiptResultSchema.parse(parsed);
  }

  async abort(_job: PurchaseJobCtx): Promise<void> {
    return;
  }

  private async runClaude(prompt: string, schemaName: string) {
    const args = [
      "-p",
      "--bare",
      "--strict-mcp-config",
      "--mcp-config",
      this.options.mcpConfigPath,
      "--tools",
      "",
      "--output-format",
      "json",
      "--max-turns",
      String(this.options.maxTurns),
      prompt,
    ];
    const result = await execa(this.options.cli, args, {
      env: safeEnv(),
      reject: false,
    });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`;
      if (/usage limit|rate limit|429|retry-after/i.test(output)) {
        throw new ExecutorLimitError(
          `Harness usage limit reached while producing ${schemaName}`,
        );
      }
      throw new Error(
        output.trim() || `Harness failed while producing ${schemaName}`,
      );
    }
    return parseHarnessOutput(result.stdout);
  }
}
