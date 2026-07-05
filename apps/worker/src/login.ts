import { loadEnv } from "./config/env";
import { BrowserManager } from "./browser";
import { WorkerConvex } from "./convexClient";

/**
 * Manual login drill (Phase 1.5): launches the store's persistent profile
 * headful so a human (locally or over noVNC) can log in once. The session
 * cookie lives in the profile dir and survives worker restarts.
 *
 * Usage: pnpm --filter @household/worker login <store> [url]
 * <store> is the Convex store id, login_ref, or name — it is resolved to
 * the store _id so the profile matches the one real purchase jobs open.
 */
const storeRef = process.argv[2];
const url = process.argv[3];

if (!storeRef) {
  console.error("Usage: pnpm --filter @household/worker login <store> [url]");
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
console.log(`Store:        ${store.name} (${store._id})`);

const browser = new BrowserManager({
  profileRoot: env.WORKER_PROFILE_ROOT,
  model: env.STAGEHAND_MODEL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  cdpPort: env.WORKER_CDP_PORT,
  headless: false,
});

const session = await browser.ensureSession(store._id);
if (url) await session.page.goto(url);

console.log(`Profile:      ${session.profileDir}`);
console.log(`CDP endpoint: ${session.cdpEndpoint}`);
console.log(
  "Log in to the store in the opened browser, then press Ctrl+C. The session persists in the profile.",
);

process.on("SIGINT", () => {
  void browser.closeAll().then(() => process.exit(0));
});
