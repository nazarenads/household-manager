import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { z } from "zod";
import type { ReceiptResult, SummaryResult } from "@household/shared";
import type { BrowserManager, BrowserSession } from "../browser";
import type { WorkContext } from "../convexClient";
import type { WorkerSecrets } from "../secrets";
import { captureRedactedScreenshot } from "../screenshot";
import { fillPaymentIfPresent } from "../payment";
import {
  summaryExtractSchema,
  receiptExtractSchema,
} from "../flows/tiendanube";
import {
  ExecutorLimitError,
  HumanInterventionError,
  isLimitError,
  type Executor,
  type PurchaseJobCtx,
} from "./types";

export type HarnessExecutorOptions = {
  browser: BrowserManager;
  secrets: WorkerSecrets;
  screenshotDir: string;
  mcpConfigDir: string;
  cli: "claude" | "codex";
  /** D11: only when explicitly enabled does the child inherit ANTHROPIC_API_KEY. */
  allowApiBilling: boolean;
};

// The harness reports human-blocking conditions instead of guessing past
// them; `blocked` maps to paused_captcha via HumanInterventionError.
const harnessSummarySchema = summaryExtractSchema.extend({
  blocked: z.string().optional(),
});
const harnessReceiptSchema = receiptExtractSchema.extend({
  blocked: z.string().optional(),
});

const SAFE_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "LANG",
  "LC_ALL",
]);

/**
 * Executor B (D3/D11): two short `claude -p` invocations against the
 * worker-owned Chrome via Playwright MCP over CDP. Invocation 1 stops at the
 * order summary; invocation 2 runs only after the human confirmation and
 * clicks the final button once. The harness gets browser tools only — no
 * shell, no filesystem, no secrets; card entry stays in worker-owned code.
 */
export class HarnessExecutor implements Executor {
  private readonly options: HarnessExecutorOptions;

  constructor(options: HarnessExecutorOptions) {
    this.options = options;
  }

  async runToSummary(job: PurchaseJobCtx): Promise<SummaryResult> {
    const { work } = job;
    const session = await this.options.browser.ensureSession(work.store._id);
    const mcpConfigPath = await this.writeMcpConfig(session);

    const lines = work.cart.lines
      .map((line) => {
        const label = line.store_item?.name ?? line.item_name;
        const url = line.store_item?.product_url
          ? ` (product page: ${line.store_item.product_url})`
          : "";
        return `- ${label}: ${line.qty} ${line.unit}${url}`;
      })
      .join("\n");

    const prompt = [
      `You are buying groceries for a private household at ${work.store.name} (https://${work.store.domain}), controlling the already-open, already-logged-in browser through the playwright tools.`,
      "",
      "Shopping list:",
      lines,
      "",
      `Shipping preference: ${work.store.shipping_preference}`,
      ...(work.store.delivery_address
        ? [
            `Delivery address: if the checkout offers saved addresses, select the one matching "${work.store.delivery_address}". Never create or edit an address.`,
          ]
        : []),
      "Delivery date: if the checkout offers delivery dates or time windows, select the EARLIEST available one.",
      "",
      "Steps: add each product to the cart (prefer the product page links above; otherwise use the store search), then proceed through checkout until the order summary page that shows the line items and the total.",
      "STOP at the order summary. Do NOT click any final purchase/confirm button ('Confirmar compra', 'Pagar ahora' or similar).",
      "Do NOT enter card numbers, CVV, or any payment credentials; if the checkout demands them before showing the summary, stop and set the `blocked` field explaining what is needed.",
      "If a captcha or login wall appears, stop and set the `blocked` field.",
      "When the summary is on screen, report it as JSON matching the output schema (amounts in ARS as plain numbers).",
    ].join("\n");

    const raw = await this.runHarness(
      prompt,
      z.toJSONSchema(harnessSummarySchema),
      mcpConfigPath,
    );
    const parsed = harnessSummarySchema.parse(raw);
    if (parsed.blocked) {
      throw new HumanInterventionError(`Harness blocked: ${parsed.blocked}`);
    }

    const shot = await captureRedactedScreenshot({
      page: session.page,
      platform: work.store.platform,
      outputDir: this.options.screenshotDir,
      name: `summary-${work.job._id}-${Date.now()}`,
    });

    return {
      screenshotPath: shot.filePath,
      total: parsed.total,
      currency: "ARS",
      lineItems: parsed.lines.map((line) => ({
        name: line.name,
        qty: line.qty,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        status:
          line.availability === "available"
            ? ("expected" as const)
            : (line.availability as "substituted" | "unavailable"),
      })),
      shippingTotal: parsed.shippingTotal,
      deliveryWindow: parsed.deliveryWindow,
      redactionApplied: shot.redactionApplied,
    };
  }

  async confirmPurchase(job: PurchaseJobCtx): Promise<ReceiptResult> {
    const { work } = job;
    const session = await this.options.browser.ensureSession(work.store._id);
    const mcpConfigPath = await this.writeMcpConfig(session);

    // Card entry (if the store asks at the end) is worker-owned code, never
    // part of the harness prompt or transcript.
    await fillPaymentIfPresent(
      session.page,
      session.cdpEndpoint,
      this.options.secrets,
      this.paymentRef(work),
    );

    const prompt = [
      "The order summary for a household purchase is on screen in the already-open browser, and the human has approved placing the order.",
      "Click the final purchase confirmation button ('Confirmar compra', 'Pagar ahora' or similar) EXACTLY ONCE, wait for the confirmation page, then report the order number and charged total as JSON matching the output schema.",
      "Set orderPlaced=true ONLY if the store explicitly confirms the order was created (thank-you page, order number). If the page still shows a payment form, the summary, or an error, set orderPlaced=false.",
      "If something blocks the confirmation (captcha, payment form demanding card data, error), do not retry clicking; set the `blocked` field instead.",
    ].join("\n");

    const raw = await this.runHarness(
      prompt,
      z.toJSONSchema(harnessReceiptSchema),
      mcpConfigPath,
    );
    const parsed = harnessReceiptSchema.parse(raw);
    if (parsed.blocked) {
      // The final click may or may not have landed — treat as unknown
      // outcome upstream (needs_reconciliation), never re-click.
      throw new Error(`Harness blocked during confirm: ${parsed.blocked}`);
    }
    if (!parsed.orderPlaced || !parsed.orderNumber) {
      throw new Error(
        `Store did not confirm the order (orderPlaced=${parsed.orderPlaced}, orderNumber=${parsed.orderNumber ?? "none"}); check the store's order history before doing anything.`,
      );
    }
    return {
      orderRef: parsed.orderNumber,
      total: parsed.total,
      currency: "ARS",
      lineItems: parsed.lines.map((line) => ({
        name: line.name,
        qty: line.qty,
        price: line.price,
      })),
    };
  }

  async abort(job: PurchaseJobCtx): Promise<void> {
    void job;
    await this.options.browser.closeSession();
  }

  private paymentRef(work: WorkContext) {
    return this.options.secrets.stores[work.store.login_ref]?.paymentRef;
  }

  private async writeMcpConfig(session: BrowserSession): Promise<string> {
    await fs.mkdir(this.options.mcpConfigDir, { recursive: true });
    const configPath = path.join(
      this.options.mcpConfigDir,
      "playwright-mcp.json",
    );
    const config = {
      mcpServers: {
        playwright: {
          command: "npx",
          args: [
            "-y",
            "@playwright/mcp",
            "--cdp-endpoint",
            session.cdpEndpoint,
          ],
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  private safeEnv() {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value && SAFE_ENV_KEYS.has(key)) env[key] = value;
    }
    if (this.options.allowApiBilling && process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    return env;
  }

  private async runHarness(
    prompt: string,
    jsonSchema: unknown,
    mcpConfigPath: string,
  ): Promise<unknown> {
    if (this.options.cli !== "claude") {
      throw new Error(
        `Harness CLI "${this.options.cli}" is not wired yet; use claude`,
      );
    }
    const args = [
      "-p",
      "--bare",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--tools",
      "",
      "--allowedTools",
      "mcp__playwright__*",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(jsonSchema),
      prompt,
    ];
    const result = await execa("claude", args, {
      env: this.safeEnv(),
      extendEnv: false,
      reject: false,
      timeout: 30 * 60 * 1000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0) {
      if (isLimitError(new Error(output))) {
        throw new ExecutorLimitError(
          "Harness usage limit reached; job paused (D11)",
        );
      }
      throw new Error(output.trim() || "Harness invocation failed");
    }
    return this.parseStructuredOutput(result.stdout);
  }

  /**
   * `--output-format json` wraps the run in a result envelope; with
   * `--json-schema` the structured object is carried inside it. Accept the
   * envelope, a `structured_output` field, or a raw JSON body.
   */
  private parseStructuredOutput(stdout: string): unknown {
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    if (envelope.structured_output !== undefined) {
      return envelope.structured_output;
    }
    if (typeof envelope.result === "string") {
      try {
        return JSON.parse(envelope.result);
      } catch {
        const match = envelope.result.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error(
          `Harness result is not JSON: ${envelope.result.slice(0, 200)}`,
        );
      }
    }
    return envelope.result ?? envelope;
  }
}
