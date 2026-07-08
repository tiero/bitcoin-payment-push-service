import "dotenv/config";
import { z } from "zod";

/**
 * SDK network literals accepted by @arkade-os/sdk (its `NetworkName` type).
 * Verify against the installed package's Network type if it changes.
 */
const networkSchema = z.enum([
  "bitcoin",
  "testnet",
  "signet",
  "mutinynet",
  "regtest",
]);

const envSchema = z
  .object({
  NETWORK: networkSchema.default("mutinynet"),
  // Boltz REST base. The boltz-swap SwapManager derives its websocket URL from this.
  BOLTZ_API_URL: z.string().url().default("https://api.boltz.mutinynet.arkade.sh"),
  ARK_SERVER_URL: z.string().url().default("https://mutinynet.arkade.sh"),
  ESPLORA_URL: z.string().url().default("https://mutinynet.com/api"),
  PORT: z.coerce.number().int().positive().default(3000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  NTFY_BASE_URL: z.string().url().optional(),
  GROUNDCONTROL_BASE_URL: z.string().url().optional(),
  EXPO_ENABLED: z.enum(["true", "false"]).optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  DATA_FILE: z.string().default("./data/registrations.json"),
  STORAGE_BACKEND: z.enum(["json", "sqlite"]).default("json"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  })
  .superRefine((data, ctx) => {
    const enabled = [
      Boolean(data.NTFY_BASE_URL),
      Boolean(data.GROUNDCONTROL_BASE_URL),
      data.EXPO_ENABLED === "true",
    ].filter(Boolean).length;
    if (enabled !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Set exactly one push provider: NTFY_BASE_URL, GROUNDCONTROL_BASE_URL, or EXPO_ENABLED=true",
      });
    }
  });

export type Network = z.infer<typeof networkSchema>;
export type Config = z.infer<typeof envSchema>;

function load(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();
