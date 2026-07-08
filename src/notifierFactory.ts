import { config } from "./config.js";
import { logger } from "./logger.js";
import { GroundControlNotifier } from "./notifier/groundControlNotifier.js";
import { NtfyNotifier } from "./notifier/ntfyNotifier.js";
import { WebPushNotifier } from "./notifier/webPushNotifier.js";
import type { Notifier } from "./notifier/types.js";

/** Builds the push provider selected by `config.provider`. */
export function createNotifier(): Notifier {
  const provider = config.provider;
  switch (provider.kind) {
    case "ntfy":
      return new NtfyNotifier(provider.baseUrl, logger);
    case "groundcontrol":
      return new GroundControlNotifier(provider.baseUrl, logger);
    case "webpush":
      return new WebPushNotifier(provider.vapid, logger);
  }
}
