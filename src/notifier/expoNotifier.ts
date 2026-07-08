import type { Logger } from "../logger.js";
import type { Notifier, NotifyPayload, NotifyTarget } from "./types.js";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** Expo accepts three delivery priorities; map our five onto them. */
const PRIORITY_MAP: Record<NonNullable<NotifyPayload["priority"]>, "normal" | "default" | "high"> = {
  min: "normal",
  low: "normal",
  default: "default",
  high: "high",
  max: "high",
};

/**
 * Sends a push via [Expo's push service](https://docs.expo.dev/push-notifications/sending-notifications/).
 * The {@link NotifyTarget.topic} is the recipient's ExpoPushToken
 * (e.g. `ExponentPushToken[xxxxxxxx]`). An access token is optional but
 * recommended in production for enhanced security and higher rate limits.
 */
export class ExpoNotifier implements Notifier {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly logger: Logger,
  ) {}

  async notify(target: NotifyTarget, payload: NotifyPayload): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;

    const message = {
      to: target.topic,
      title: payload.title,
      body: payload.body,
      priority: PRIORITY_MAP[payload.priority ?? "default"],
      sound: "default",
      data: {
        ...(payload.memo ? { memo: payload.memo } : {}),
        ...(payload.preimage ? { preimage: payload.preimage } : {}),
        ...(payload.amtPaidSat !== undefined ? { amtPaidSat: payload.amtPaidSat } : {}),
      },
    };

    const res = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Expo push failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
    // Expo returns HTTP 200 even for a per-message failure: the ticket carries
    // `data.status === "error"` (e.g. DeviceNotRegistered). Surface it so the
    // caller's retry/sweep logic treats it as a failed delivery.
    const json = (await res.json().catch(() => null)) as {
      data?: { status?: string; message?: string };
    } | null;
    if (json?.data?.status && json.data.status !== "ok") {
      throw new Error(`Expo push ticket error: ${json.data.message ?? "unknown"}`);
    }
    this.logger.info({ to: target.topic, title: payload.title }, "expo push sent");
  }
}
