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
  // Web Push (VAPID, RFC 8292). All three are required together to enable it.
  // Generate a key pair with `pnpm gen:vapid`. The subject is a mailto:/https: URI.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  DATA_FILE: z.string().default("./data/registrations.json"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  })
  .superRefine((data, ctx) => {
    const vapidParts = [data.VAPID_PUBLIC_KEY, data.VAPID_PRIVATE_KEY, data.VAPID_SUBJECT].filter(
      Boolean,
    ).length;
    if (vapidParts > 0 && vapidParts < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Web Push needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together",
      });
    }

    const providers = [
      Boolean(data.NTFY_BASE_URL),
      Boolean(data.GROUNDCONTROL_BASE_URL),
      vapidParts === 3,
    ].filter(Boolean).length;
    if (providers !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Set exactly one push provider: NTFY_BASE_URL, GROUNDCONTROL_BASE_URL, or VAPID_* (Web Push)",
      });
    }
  })
  // Collapse the raw env vars into a single discriminated provider so selection
  // logic exists exactly once; everything downstream switches on `provider.kind`.
  .transform((data) => ({ ...data, provider: toProvider(data) }));

/** The single push provider the service is configured with. */
export type ProviderConfig =
  | { kind: "ntfy"; baseUrl: string }
  | { kind: "groundcontrol"; baseUrl: string }
  | { kind: "webpush"; vapid: { subject: string; publicKey: string; privateKey: string } };

function toProvider(data: {
  NTFY_BASE_URL?: string;
  GROUNDCONTROL_BASE_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): ProviderConfig {
  if (data.NTFY_BASE_URL) return { kind: "ntfy", baseUrl: data.NTFY_BASE_URL };
  if (data.GROUNDCONTROL_BASE_URL) {
    return { kind: "groundcontrol", baseUrl: data.GROUNDCONTROL_BASE_URL };
  }
  // The superRefine above guarantees the remaining case is a complete VAPID set.
  return {
    kind: "webpush",
    vapid: {
      subject: data.VAPID_SUBJECT!,
      publicKey: data.VAPID_PUBLIC_KEY!,
      privateKey: data.VAPID_PRIVATE_KEY!,
    },
  };
}

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
