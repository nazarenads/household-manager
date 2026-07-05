import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Stagehand } from "@browserbasehq/stagehand";

export type StagehandPage = Awaited<
  ReturnType<Stagehand["context"]["awaitActivePage"]>
>;

export type BrowserSession = {
  storeId: string;
  profileDir: string;
  cdpEndpoint: string;
  stagehand: Stagehand;
  page: StagehandPage;
};

export type BrowserManagerOptions = {
  profileRoot: string;
  model: string;
  anthropicApiKey?: string | undefined;
  cdpHost?: string | undefined;
  cdpPort?: number | undefined;
  headless?: boolean | undefined;
};

export function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Owns the worker's Chrome lifecycle (D2): Stagehand LOCAL launch with a
 * persistent per-store profile and a fixed CDP port. One live session at a
 * time — jobs are serialized, and a single CDP port keeps the endpoint
 * predictable for the harness executor and noVNC recovery.
 *
 * Stagehand's own caches are disabled (D1): selfHeal off, serverCache off,
 * no cacheDir. Healing is owned by the trajectory runner.
 */
export class BrowserManager {
  private readonly options: BrowserManagerOptions;
  private readonly profileRoot: string;
  private current: BrowserSession | null = null;

  constructor(options: BrowserManagerOptions) {
    this.options = options;
    this.profileRoot = expandHome(options.profileRoot);
  }

  cdpEndpoint() {
    const host = this.options.cdpHost ?? "127.0.0.1";
    const port = this.options.cdpPort ?? 9222;
    return `http://${host}:${port}`;
  }

  profileDir(storeId: string) {
    return path.join(this.profileRoot, storeId);
  }

  async ensureSession(storeId: string): Promise<BrowserSession> {
    if (this.current?.storeId === storeId) return this.current;
    if (this.current) await this.closeSession();

    const profileDir = this.profileDir(storeId);
    await fs.mkdir(profileDir, { recursive: true });

    // Chrome refuses to start as root (e.g. on a VPS) without --no-sandbox.
    // Only disable the sandbox where Chrome would otherwise not launch at all,
    // so non-root dev machines keep the sandbox enabled.
    const runningAsRoot =
      typeof process.getuid === "function" && process.getuid() === 0;
    const chromeArgs = runningAsRoot
      ? ["--no-sandbox", "--disable-gpu"]
      : [];

    const stagehand = new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: {
        userDataDir: profileDir,
        preserveUserDataDir: true,
        headless: this.options.headless ?? false,
        port: this.options.cdpPort ?? 9222,
        args: chromeArgs,
      },
      model: this.options.anthropicApiKey
        ? {
            modelName: this.options.model,
            apiKey: this.options.anthropicApiKey,
          }
        : this.options.model,
      keepAlive: true,
      disableAPI: true,
      serverCache: false,
      selfHeal: false,
      disablePino: true,
      verbose: 0,
    });
    await stagehand.init();
    const page = await stagehand.context.awaitActivePage();

    this.current = {
      storeId,
      profileDir,
      cdpEndpoint: this.cdpEndpoint(),
      stagehand,
      page,
    };
    return this.current;
  }

  async closeSession(): Promise<void> {
    if (!this.current) return;
    const session = this.current;
    this.current = null;
    try {
      await session.stagehand.close();
    } catch (error) {
      console.error(
        `Failed to close browser session for ${session.storeId}:`,
        error,
      );
    }
  }

  async closeAll(): Promise<void> {
    await this.closeSession();
  }
}
