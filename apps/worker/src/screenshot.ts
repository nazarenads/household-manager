import path from "node:path";
import fs from "node:fs/promises";
import type { StagehandPage } from "./browser";

const REDACTION_STYLE_ID = "__household_redaction__";

/**
 * Selectors hidden before the checkout screenshot (D14): addresses, contact
 * data, and payment widgets must never reach Convex storage. Selectors are
 * per-platform best effort; the structured extract is the source of truth for
 * approval, the screenshot is supporting evidence.
 */
export const REDACTION_SELECTORS: Record<string, string[]> = {
  common: [
    "[class*='address']",
    "[class*='direccion']",
    "[id*='address']",
    "[class*='phone']",
    "[class*='telefono']",
    "[class*='email']",
    "[class*='card']",
    "[class*='tarjeta']",
    "input[type='email']",
    "input[type='tel']",
  ],
  tiendanube: ["[class*='contact-information']", "[class*='customer']"],
  mercadolibre: ["[class*='buyer']", "[class*='payment-method-info']"],
  coto: [],
  vtex: ["[class*='client-profile']", "[class*='shipping-data']"],
};

export function selectorsForPlatform(platform: string): string[] {
  return [
    ...REDACTION_SELECTORS.common!,
    ...(REDACTION_SELECTORS[platform] ?? []),
  ];
}

export type RedactedScreenshot = {
  filePath: string;
  redactionApplied: boolean;
};

export async function captureRedactedScreenshot(args: {
  page: StagehandPage;
  platform: string;
  outputDir: string;
  name: string;
}): Promise<RedactedScreenshot> {
  const { page, platform, outputDir, name } = args;
  const selectors = selectorsForPlatform(platform);
  const selectorList = selectors.join(", ");

  let redactionApplied = false;
  try {
    await page.evaluate(
      ({ styleId, css }: { styleId: string; css: string }) => {
        const existing = document.getElementById(styleId);
        if (existing) existing.remove();
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = css;
        document.head.appendChild(style);
      },
      {
        styleId: REDACTION_STYLE_ID,
        css: `${selectorList} { visibility: hidden !important; }`,
      },
    );
    redactionApplied = true;
  } catch (error) {
    console.error("Screenshot redaction injection failed:", error);
  }

  try {
    const bytes = await page.screenshot({ fullPage: true });
    await fs.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${name}.png`);
    await fs.writeFile(filePath, bytes);
    return { filePath, redactionApplied };
  } finally {
    if (redactionApplied) {
      await page
        .evaluate((styleId: string) => {
          document.getElementById(styleId)?.remove();
        }, REDACTION_STYLE_ID)
        .catch(() => undefined);
    }
  }
}

export async function deleteLocalScreenshot(filePath: string) {
  await fs.rm(filePath, { force: true });
}
