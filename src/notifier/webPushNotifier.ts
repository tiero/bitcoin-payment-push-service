import webpush, { WebPushError } from "web-push";
import type { Logger } from "../logger.js";
import {
  PermanentDeliveryError,
  type Notifier,
  type NotifyPayload,
  type NotifyTarget,
} from "./types.js";

/** VAPID identity used to sign Web Push requests (RFC 8292). */
export interface VapidConfig {
  /** `mailto:` or `https:` contact URI the push service can use to reach you. */
  subject: string;
  /** VAPID application server public key (base64url). Also handed to the PWA. */
  publicKey: string;
  /** VAPID application server private key (base64url). Keep this secret. */
  privateKey: string;
}

/** Web Push urgency header values (RFC 8030 §5.3). */
const URGENCY_MAP: Record<NonNullable<NotifyPayload["priority"]>, "very-low" | "low" | "normal" | "high"> = {
  min: "very-low",
  low: "low",
  default: "normal",
  high: "high",
  max: "high",
};

/**
 * How long (seconds) the push service should retain the message if the device is
 * offline. The push is a *wake-up* to finalize a claim, so a few hours is plenty —
 * well within the reverse swap's own timeout — while still surviving a phone that
 * is briefly unreachable.
 */
const TTL_SECONDS = 3 * 60 * 60;

/**
 * Delivers a push via the standard **W3C Web Push API** — the mechanism PWAs use
 * to receive notifications through their service worker, even when the tab is
 * closed. Payloads are encrypted end-to-end (RFC 8291) and the request is signed
 * with VAPID (RFC 8292); the heavy lifting is done by the `web-push` library.
 * VAPID details are passed per send (not via `webpush.setVapidDetails`, which
 * mutates library-global state a second instance would clobber).
 *
 * The delivery target is the {@link WebPushSubscription} the PWA obtained from
 * `PushManager.subscribe()` and posted to `/register`. The service worker receives
 * a JSON body ({ title, body, ... }) in its `push` event and calls
 * `showNotification()`.
 */
export class WebPushNotifier implements Notifier {
  readonly targetKind = "webpush" as const;

  constructor(
    private readonly vapid: VapidConfig,
    private readonly logger: Logger,
  ) {}

  async notify(target: NotifyTarget, payload: NotifyPayload): Promise<void> {
    // Unreachable through /register (it rejects mismatched kinds), but a stale
    // persisted registration can hit this after a provider switch — permanent,
    // so the delivery pipeline prunes it instead of retrying.
    if (target.kind !== "webpush") {
      throw new PermanentDeliveryError(`WebPushNotifier cannot deliver to a ${target.kind} target`);
    }
    const { subscription } = target;

    // The service worker's `push` handler reads these fields to build the
    // notification. Undefined optional fields are dropped by JSON.stringify.
    const data = JSON.stringify({
      title: payload.title,
      body: payload.body,
      tags: payload.tags,
      memo: payload.memo || undefined,
      amtPaidSat: payload.amtPaidSat,
    });

    try {
      await webpush.sendNotification(subscription, data, {
        TTL: TTL_SECONDS,
        urgency: URGENCY_MAP[payload.priority ?? "default"],
        vapidDetails: this.vapid,
      });
    } catch (err) {
      if (err instanceof WebPushError) {
        const message = `web push failed: ${err.statusCode} ${err.body ?? ""}`.trim();
        // 404/410: the subscription is permanently gone (unsubscribed/expired) —
        // RFC 8030 says stop sending to it. 401/403: the subscription is bound to
        // a different VAPID key (e.g. after a key rotation), which no retry with
        // the current keys can ever fix. The caller prunes either way.
        if ([401, 403, 404, 410].includes(err.statusCode)) {
          throw new PermanentDeliveryError(message);
        }
        throw new Error(message);
      }
      throw err;
    }
    this.logger.info({ endpoint: subscription.endpoint, title: payload.title }, "web push sent");
  }
}
