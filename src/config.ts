import "dotenv/config";
import { z } from "zod";
import type { VapidConfig } from "./notifier/webPushNotifier.js";

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
  // Web Push (VAPID, RFC 8292). All three are required together to enable it.
  // Generate a key pair with `pnpm gen:vapid`. Key shapes are validated here so a
  // truncated/swapped key fails at boot, not at the first (unretryable) send.
  VAPID_PUBLIC_KEY: z
    .string()
    .regex(/^B[A-Za-z0-9_-]{86}$/, "must be a base64url uncompressed P-256 public key (87 chars, starts with 'B')")
    .optional(),
  VAPID_PRIVATE_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "must be a base64url P-256 private key (43 chars)")
    .optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:)/, "must be a mailto: or https: contact URI")
    .optional(),
  DATA_FILE: z.string().default("./data/registrations.json"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  })
  // Validate the provider choice and collapse it into a single discriminated
  // `provider` in one pass, so selection logic exists exactly once and no
  // downstream code needs non-null assertions on the raw env vars.
  .transform((data, ctx) => {
    const candidates: ProviderConfig[] = [];
    if (data.NTFY_BASE_URL) candidates.push({ kind: "ntfy", baseUrl: data.NTFY_BASE_URL });
    if (data.GROUNDCONTROL_BASE_URL) {
      candidates.push({ kind: "groundcontrol", baseUrl: data.GROUNDCONTROL_BASE_URL });
    }
    if (data.VAPID_SUBJECT && data.VAPID_PUBLIC_KEY && data.VAPID_PRIVATE_KEY) {
      candidates.push({
        kind: "webpush",
        vapid: {
          subject: data.VAPID_SUBJECT,
          publicKey: data.VAPID_PUBLIC_KEY,
          privateKey: data.VAPID_PRIVATE_KEY,
        },
      });
    } else if (data.VAPID_SUBJECT || data.VAPID_PUBLIC_KEY || data.VAPID_PRIVATE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Web Push needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together",
      });
      return z.NEVER;
    }
    if (candidates.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Set exactly one push provider: NTFY_BASE_URL, GROUNDCONTROL_BASE_URL, or VAPID_* (Web Push)",
      });
      return z.NEVER;
    }
    return { ...data, provider: candidates[0]! };
  });

/** The single push provider the service is configured with. */
export type ProviderConfig =
  | { kind: "ntfy"; baseUrl: string }
  | { kind: "groundcontrol"; baseUrl: string }
  | { kind: "webpush"; vapid: VapidConfig };

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
