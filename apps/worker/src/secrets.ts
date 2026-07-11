import fs from "node:fs/promises";
import { z } from "zod";

const secretsSchema = z.object({
  stores: z.record(
    z.string(),
    z.object({
      username: z.string().optional(),
      password: z.string().optional(),
      paymentRef: z.string().optional(),
    }),
  ),
  proxies: z.record(
    z.string(),
    z.object({
      server: z.string(),
      username: z.string().optional(),
      password: z.string().optional(),
    }),
  ),
  payments: z.record(
    z.string(),
    z.object({
      holder: z.string(),
      number: z.string(),
      expiry: z.string(),
      cvv: z.string(),
      /** Card holder document (DNI) — some AR checkouts require it. */
      holderId: z.string().optional(),
    }),
  ),
});

export type WorkerSecrets = z.infer<typeof secretsSchema>;

export async function loadSecrets(filePath: string): Promise<WorkerSecrets> {
  const raw = await fs.readFile(filePath, "utf8");
  return secretsSchema.parse(JSON.parse(raw));
}
