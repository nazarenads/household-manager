import { loadEnv } from "./config/env";
import { BrowserManager } from "./browser";

const storeId = process.argv[2];

if (!storeId) {
  console.error("Usage: pnpm --filter @household/worker login <storeId>");
  process.exit(1);
}

const env = loadEnv();
const browser = new BrowserManager({ profileRoot: env.WORKER_PROFILE_ROOT });
const session = await browser.ensureSession(storeId);

console.log(
  "Open the VPS noVNC/Tailscale browser and log in for this store profile:",
);
console.log(JSON.stringify(session, null, 2));
