import { z } from "zod";

const envSchema = z.object({
  CONVEX_URL: z.string().url(),
  WORKER_TOKEN: z.string().min(16),
  WORKER_ID: z.string().default("local-dev"),
  WORKER_PROFILE_ROOT: z.string().default("~/.household-manager/profiles"),
  WORKER_SECRETS_FILE: z.string().default("apps/worker/secrets.local.json"),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return envSchema.parse(source);
}
