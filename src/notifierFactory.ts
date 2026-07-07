import { config } from "./config.js";
import { logger } from "./logger.js";
import { GroundControlNotifier } from "./notifier/groundControlNotifier.js";
import { NtfyNotifier } from "./notifier/ntfyNotifier.js";
import { WebPushNotifier } from "./notifier/webPushNotifier.js";
import type { Notifier } from "./notifier/types.js";

/**
 * Selects the push provider from config. The env validation guarantees exactly
 * one of these is configured, so the order here only breaks ties that can't occur.
 */
export function createNotifier(): Notifier {
  if (config.GROUNDCONTROL_BASE_URL) {
    return new GroundControlNotifier(config.GROUNDCONTROL_BASE_URL, logger);
  }
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT) {
    return new WebPushNotifier(
      {
        subject: config.VAPID_SUBJECT,
        publicKey: config.VAPID_PUBLIC_KEY,
        privateKey: config.VAPID_PRIVATE_KEY,
      },
      logger,
    );
  }
  return new NtfyNotifier(config.NTFY_BASE_URL!, logger);
}
