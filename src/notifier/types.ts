/**
 * A W3C Push API subscription, as produced by `PushManager.subscribe()` in a
 * browser/PWA and serialized with `subscription.toJSON()`. It is the delivery
 * target for {@link WebPushNotifier}.
 */
export interface WebPushSubscription {
  endpoint: string;
  /** Present on real subscriptions; browsers may set it to null. */
  expirationTime?: number | null;
  keys: {
    /** The client's P-256 ECDH public key (base64url). */
    p256dh: string;
    /** The client's auth secret (base64url). */
    auth: string;
  };
}

export interface NotifyTarget {
  /** ntfy topic, or preimage hash (hex) for GroundControl. */
  topic?: string;
  /** Web Push subscription (endpoint + keys) for {@link WebPushNotifier}. */
  subscription?: WebPushSubscription;
}

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
  notify(target: NotifyTarget, payload: NotifyPayload): Promise<void>;
}
