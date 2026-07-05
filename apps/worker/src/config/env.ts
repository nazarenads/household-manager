import { z } from "zod";

const envSchema = z.object({
  CONVEX_URL: z.string().url(),
  WORKER_TOKEN: z.string().min(16),
  WORKER_ID: z.string().default("local-dev"),
  WORKER_PROFILE_ROOT: z.string().default("~/.household-manager/profiles"),
  WORKER_SCREENSHOT_DIR: z.string().default("~/.household-manager/screenshots"),
  WORKER_SECRETS_FILE: z.string().default("apps/worker/secrets.local.json"),
  WORKER_CDP_PORT: z.coerce.number().int().positive().default(9222),
  WORKER_HEADLESS: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  STAGEHAND_MODEL: z.string().default("anthropic/claude-haiku-4-5"),
  // Billing-sensitive (D11): must be set deliberately for the Stagehand path;
  // never assumed present.
  ANTHROPIC_API_KEY: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return envSchema.parse(source);
}
