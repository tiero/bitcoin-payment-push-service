import type { PushSubscription } from "web-push";

/**
 * A W3C Push API subscription, as produced by `PushManager.subscribe()` in a
 * browser/PWA and serialized with `subscription.toJSON()`. Re-exported from
 * `web-push` so the wire shape can't drift from what the library sends to.
 */
export type WebPushSubscription = PushSubscription;

/**
 * Where a notification is delivered. A discriminated union so an empty or
 * double-addressed target is unrepresentable: `topic` addresses ntfy (a topic
 * name) and GroundControl (a preimage hash); `webpush` addresses a PWA's push
 * subscription.
 */
export type NotifyTarget =
  | { kind: "topic"; topic: string }
  | { kind: "webpush"; subscription: WebPushSubscription };

export type NotifyTargetKind = NotifyTarget["kind"];

/**
 * Delivery failed and will keep failing for this target — retrying is useless
 * (e.g. an expired/unsubscribed Web Push subscription, or a target kind the
 * configured provider can't address). The caller should prune the registration
 * instead of leaving it for the retry sweep.
 */
export class PermanentDeliveryError extends Error {}

export interface NotifyPayload {
  title: string;
  body: string;
  /** Optional tags/emoji (ntfy supports these); ignored by providers that can't use them. */
  tags?: string[];
  priority?: "min" | "low" | "default" | "high" | "max";
  memo?: string;
  /** Empty when the wallet redacts the preimage at /register. */
  preimage?: string;
  amtPaidSat?: number;
}

/**
 * Pluggable push delivery. The sample ships NtfyNotifier, GroundControlNotifier
 * and WebPushNotifier; FCM / Expo implementations can be added the same way,
 * without touching the monitor.
 */
export interface Notifier {
  /** The target kind this provider can deliver to; /register rejects the rest. */
  readonly targetKind: NotifyTargetKind;
  notify(target: NotifyTarget, payload: NotifyPayload): Promise<void>;
}
