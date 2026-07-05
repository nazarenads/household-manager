import fs from "node:fs/promises";
import { loadEnv } from "./config/env";
import { actOrThrow } from "./act";
import { BrowserManager } from "./browser";
import { WorkerConvex } from "./convexClient";
import type { Action } from "@browserbasehq/stagehand";

/**
 * S2.0 spike checklist (the plan's biggest unknown), runnable on the VPS or
 * locally. Each subcommand validates one claim:
 *
 *   launch <storeId> <url>
 *     (a) persistent profile + fixed CDP port. Run, Ctrl+C, re-run after a
 *     restart/reboot and verify the session/login persisted. While it is
 *     open, verify Playwright MCP can attach to the printed CDP endpoint.
 *
 *   observe <storeId> <url> "<instruction>" <out.json>
 *     Resolve an instruction to an action object with the LLM and persist it.
 *
 *   replay <storeId> <url> <saved.json>
 *     (c) replay the persisted action via act(action) and print LLM token
 *     deltas — the replay must show zero new tokens.
 *
 *   heal <storeId> <url> <saved.json> "<instruction>"
 *     (d) sabotage test: edit the selector in saved.json first, then verify
 *     replay fails and a fresh observe(instruction) heals it.
 */

const [command, storeRef, url, ...rest] = process.argv.slice(2);

if (!command || !storeRef || !url) {
  console.error(
    "Usage: spike <launch|observe|replay|heal> <store> <url> [args...]",
  );
  process.exit(1);
}

const env = loadEnv();
// Resolve login_ref/name to the store _id so the spike exercises (and
// warms up) the same persistent profile that real purchase jobs will open.
const convex = new WorkerConvex({
  convexUrl: env.CONVEX_URL,
  workerToken: env.WORKER_TOKEN,
  workerId: env.WORKER_ID,
});
const store = await convex.resolveStore(storeRef);
convex.close();
console.log(`Store:        ${store.name} (${store._id})`);

if ((command === "observe" || command === "heal") && !env.ANTHROPIC_API_KEY) {
  console.error(`${command} needs LLM calls; set ANTHROPIC_API_KEY`);
  process.exit(1);
}

const browser = new BrowserManager({
  profileRoot: env.WORKER_PROFILE_ROOT,
  model: env.STAGEHAND_MODEL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  cdpPort: env.WORKER_CDP_PORT,
  headless: env.WORKER_HEADLESS,
});

const session = await browser.ensureSession(store._id);
const { stagehand, page } = session;

async function tokens() {
  const metrics = await stagehand.metrics;
  return metrics.totalPromptTokens + metrics.totalCompletionTokens;
}

await page.goto(url);
console.log(`Profile:      ${session.profileDir}`);
console.log(`CDP endpoint: ${session.cdpEndpoint}`);

switch (command) {
  case "launch": {
    console.log(
      "Browser is up. Test CDP attach from another process, then Ctrl+C.",
    );
    await new Promise((resolve) => process.on("SIGINT", resolve));
    break;
  }
  case "observe": {
    const [instruction, outFile] = rest;
    if (!instruction || !outFile) {
      console.error('observe needs "<instruction>" <out.json>');
      process.exit(1);
    }
    const before = await tokens();
    const [action] = await stagehand.observe(instruction);
    if (!action) throw new Error("observe() returned no action");
    await fs.writeFile(outFile, JSON.stringify(action, null, 2));
    console.log(`Saved action (${(await tokens()) - before} LLM tokens):`);
    console.log(JSON.stringify(action, null, 2));
    break;
  }
  case "replay": {
    const [savedFile] = rest;
    if (!savedFile) {
      console.error("replay needs <saved.json>");
      process.exit(1);
    }
    const action = JSON.parse(await fs.readFile(savedFile, "utf8")) as Action;
    const before = await tokens();
    await actOrThrow(stagehand, action);
    const used = (await tokens()) - before;
    console.log(
      `Replay succeeded with ${used} LLM tokens ${used === 0 ? "(zero-LLM confirmed)" : "(NOT zero — investigate!)"}`,
    );
    break;
  }
  case "heal": {
    const [savedFile, instruction] = rest;
    if (!savedFile || !instruction) {
      console.error('heal needs <saved.json> "<instruction>"');
      process.exit(1);
    }
    const action = JSON.parse(await fs.readFile(savedFile, "utf8")) as Action;
    try {
      await actOrThrow(stagehand, action);
      console.log(
        "Cached action still works — sabotage the selector in the JSON to test healing.",
      );
    } catch {
      const before = await tokens();
      const [healed] = await stagehand.observe(instruction);
      if (!healed) throw new Error("Heal observe() returned no action");
      await actOrThrow(stagehand, healed);
      await fs.writeFile(savedFile, JSON.stringify(healed, null, 2));
      console.log(
        `Healed and re-saved (${(await tokens()) - before} LLM tokens):`,
      );
      console.log(JSON.stringify(healed, null, 2));
    }
    break;
  }
  default:
    console.error(`Unknown spike command: ${command}`);
    process.exit(1);
}

await browser.closeAll();
process.exit(0);
