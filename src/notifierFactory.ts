import { config } from "./config.js";
import { logger } from "./logger.js";
import { GroundControlNotifier } from "./notifier/groundControlNotifier.js";
import { NtfyNotifier } from "./notifier/ntfyNotifier.js";
import { ExpoNotifier } from "./notifier/expoNotifier.js";
import type { Notifier } from "./notifier/types.js";

/** Selects the push provider from whichever base URL is configured. */
export function createNotifier(): Notifier {
  if (config.EXPO_ENABLED === "true") {
    return new ExpoNotifier(config.EXPO_ACCESS_TOKEN, logger);
  }
  if (config.GROUNDCONTROL_BASE_URL) {
    return new GroundControlNotifier(config.GROUNDCONTROL_BASE_URL, logger);
  }
  return new NtfyNotifier(config.NTFY_BASE_URL!, logger);
}
