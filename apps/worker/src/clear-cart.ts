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
 *
 * NB: keep the page.evaluate() callbacks to a single inline expression tree —
 * Stagehand's serializer throws an opaque "Uncaught" when the callback
 * declares named inner helpers.
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
  return page.evaluate(() => ({
    deleteControlCount: [...document.querySelectorAll("a, button")].filter(
      (el) =>
        (el as HTMLElement).offsetParent !== null &&
        ((el.className?.toString() ?? "").toLowerCase().includes("delete") ||
          (el.className?.toString() ?? "").toLowerCase().includes("remove") ||
          (el.getAttribute("aria-label") ?? "")
            .toLowerCase()
            .includes("eliminar") ||
          (el.getAttribute("aria-label") ?? "")
            .toLowerCase()
            .includes("quitar") ||
          (el.textContent ?? "").trim().toLowerCase() === "eliminar" ||
          (el.textContent ?? "").trim().toLowerCase() === "quitar"),
    ).length,
    looksEmpty:
      document.body.innerText.toLowerCase().includes("vacío") ||
      document.body.innerText.toLowerCase().includes("vacio") ||
      document.body.innerText.toLowerCase().includes("no hay productos"),
  }));
}

function clickFirstDeleteControl() {
  return page.evaluate(() => {
    const control = [...document.querySelectorAll("a, button")].find(
      (el) =>
        (el as HTMLElement).offsetParent !== null &&
        ((el.className?.toString() ?? "").toLowerCase().includes("delete") ||
          (el.className?.toString() ?? "").toLowerCase().includes("remove") ||
          (el.getAttribute("aria-label") ?? "")
            .toLowerCase()
            .includes("eliminar") ||
          (el.getAttribute("aria-label") ?? "")
            .toLowerCase()
            .includes("quitar") ||
          (el.textContent ?? "").trim().toLowerCase() === "eliminar" ||
          (el.textContent ?? "").trim().toLowerCase() === "quitar"),
    );
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
