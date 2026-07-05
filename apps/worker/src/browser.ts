import path from "node:path";
import os from "node:os";

export type BrowserSession = {
  storeId: string;
  profileDir: string;
  cdpEndpoint: string;
};

export type BrowserManagerOptions = {
  profileRoot: string;
  cdpHost?: string;
  cdpPort?: number;
};

function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export class BrowserManager {
  private readonly profileRoot: string;
  private readonly cdpHost: string;
  private readonly cdpPort: number;

  constructor(options: BrowserManagerOptions) {
    this.profileRoot = expandHome(options.profileRoot);
    this.cdpHost = options.cdpHost ?? "127.0.0.1";
    this.cdpPort = options.cdpPort ?? 9222;
  }

  async ensureSession(storeId: string): Promise<BrowserSession> {
    const profileDir = path.join(this.profileRoot, storeId);
    return {
      storeId,
      profileDir,
      cdpEndpoint: `http://${this.cdpHost}:${this.cdpPort}`,
    };
  }

  async closeStoreTab(_storeId: string): Promise<void> {
    // The concrete Stagehand/Chrome lifecycle lands in S2.0 after VPS validation.
  }
}
