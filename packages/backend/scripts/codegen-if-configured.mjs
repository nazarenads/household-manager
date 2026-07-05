import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function hasConvexDeployment() {
  if (process.env.CONVEX_DEPLOYMENT) return true;
  for (const file of [".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), file);
    if (!existsSync(filePath)) continue;
    const contents = readFileSync(filePath, "utf8");
    if (/^CONVEX_DEPLOYMENT=/m.test(contents)) return true;
  }
  return false;
}

if (!hasConvexDeployment()) {
  console.log(
    "Skipping Convex codegen: run `pnpm --filter @household/backend dev` to configure a deployment.",
  );
  process.exit(0);
}

const result = spawnSync("convex", ["codegen", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
