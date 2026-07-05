import { loadEnv } from "./config/env";
import { BrowserManager } from "./browser";

/**
 * Manual login drill (Phase 1.5): launches the store's persistent profile
 * headful so a human (locally or over noVNC) can log in once. The session
 * cookie lives in the profile dir and survives worker restarts.
 *
 * Usage: pnpm --filter @household/worker login <storeId> [url]
 */
const storeId = process.argv[2];
const url = process.argv[3];

if (!storeId) {
  console.error("Usage: pnpm --filter @household/worker login <storeId> [url]");
  process.exit(1);
}

const env = loadEnv();
const browser = new BrowserManager({
  profileRoot: env.WORKER_PROFILE_ROOT,
  model: env.STAGEHAND_MODEL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  cdpPort: env.WORKER_CDP_PORT,
  headless: false,
});

const session = await browser.ensureSession(storeId);
if (url) await session.page.goto(url);

console.log(`Profile:      ${session.profileDir}`);
console.log(`CDP endpoint: ${session.cdpEndpoint}`);
console.log(
  "Log in to the store in the opened browser, then press Ctrl+C. The session persists in the profile.",
);

process.on("SIGINT", () => {
  void browser.closeAll().then(() => process.exit(0));
});
