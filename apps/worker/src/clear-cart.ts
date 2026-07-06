import { loadEnv } from "./config/env";
import { actOrThrow } from "./act";
import { BrowserManager } from "./browser";
import { WorkerConvex } from "./convexClient";
import * as tiendanube from "./flows/tiendanube";

/**
 * Empty the store cart between validation runs so each purchase attempt
 * starts from a known state:
 *
 *   pnpm --filter @household/worker run clear-cart <store>
 *
 * Removal is DOM-first (zero LLM): click anything that looks like a cart-item
 * delete control, reload, repeat. Falls back to one observe/act per item if
 * the theme uses unrecognizable controls.
 */

const [storeRef] = process.argv.slice(2);
if (!storeRef) {
  console.error("Usage: clear-cart <store>");
  process.exit(1);
}

const env = loadEnv();
const convex = new WorkerConvex({
  convexUrl: env.CONVEX_URL,
  workerToken: env.WORKER_TOKEN,
  workerId: env.WORKER_ID,
});
const store = await convex.resolveStore(storeRef);
convex.close();

const browser = new BrowserManager({
  profileRoot: env.WORKER_PROFILE_ROOT,
  model: env.STAGEHAND_MODEL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  cdpPort: env.WORKER_CDP_PORT,
  headless: env.WORKER_HEADLESS,
});
const session = await browser.ensureSession(store._id);
const { page, stagehand } = session;

function snapshotCart() {
  return page.evaluate(() => {
    const isVisible = (el: Element) =>
      (el as HTMLElement).offsetParent !== null;
    const deleteControls = [
      ...document.querySelectorAll("a, button"),
    ].filter((el) => {
      if (!isVisible(el)) return false;
      const cls = (el.className?.toString() ?? "").toLowerCase();
      const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
      const text = (el.textContent ?? "").trim().toLowerCase();
      return (
        cls.includes("delete") ||
        cls.includes("remove") ||
        aria.includes("eliminar") ||
        aria.includes("quitar") ||
        aria.includes("remove") ||
        text === "eliminar" ||
        text === "quitar"
      );
    });
    const bodyText = document.body.innerText.toLowerCase();
    const looksEmpty =
      bodyText.includes("vacío") ||
      bodyText.includes("vacio") ||
      bodyText.includes("no hay productos");
    return { deleteControlCount: deleteControls.length, looksEmpty };
  });
}

function clickFirstDeleteControl() {
  return page.evaluate(() => {
    const isVisible = (el: Element) =>
      (el as HTMLElement).offsetParent !== null;
    const control = [...document.querySelectorAll("a, button")].find((el) => {
      if (!isVisible(el)) return false;
      const cls = (el.className?.toString() ?? "").toLowerCase();
      const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
      const text = (el.textContent ?? "").trim().toLowerCase();
      return (
        cls.includes("delete") ||
        cls.includes("remove") ||
        aria.includes("eliminar") ||
        aria.includes("quitar") ||
        aria.includes("remove") ||
        text === "eliminar" ||
        text === "quitar"
      );
    });
    (control as HTMLElement | undefined)?.click();
    return Boolean(control);
  });
}

for (let round = 0; round < 12; round += 1) {
  await page.goto(tiendanube.cartUrl(store.domain));
  await page.waitForTimeout(1500);
  const state = await snapshotCart();
  if (state.looksEmpty || state.deleteControlCount === 0) {
    console.log(
      state.looksEmpty
        ? "Cart is empty."
        : "No delete controls found; assuming empty cart.",
    );
    break;
  }
  console.log(
    `Round ${round + 1}: ${state.deleteControlCount} delete control(s); removing one`,
  );
  const clicked = await clickFirstDeleteControl();
  if (!clicked) {
    console.log("DOM removal failed; falling back to one observe/act");
    await actOrThrow(
      stagehand,
      "Remove the first product from the shopping cart",
    );
  }
  await page.waitForTimeout(2000);
}

await browser.closeAll();
process.exit(0);
