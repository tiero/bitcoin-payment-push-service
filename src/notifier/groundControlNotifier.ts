import type { Logger } from "../logger.js";
import { PermanentDeliveryError, type Notifier, type NotifyPayload, type NotifyTarget } from "./types.js";

/** Body for GroundControl `POST /lightningInvoiceGotSettled`. */
export interface LightningInvoiceSettledNotification {
  memo: string;
  preimage: string;
  hash: string;
  amt_paid_sat: number;
}

/**
 * Notifies [GroundControl](https://github.com/BlueWallet/GroundControl/) that a
 * Lightning invoice was paid. GroundControl looks up devices subscribed to the
 * preimage hash (via `/majorTomToGroundControl`) and enqueues FCM/APNS pushes.
 */
export class GroundControlNotifier implements Notifier {
  readonly targetKind = "topic" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
  ) {}

  async notify(target: NotifyTarget, payload: NotifyPayload): Promise<void> {
    // Unreachable through /register (it rejects mismatched kinds), but a stale
    // persisted registration can hit this after a provider switch — permanent.
    if (target.kind !== "topic") {
      throw new PermanentDeliveryError(
        `GroundControlNotifier cannot deliver to a ${target.kind} target`,
      );
    }
    const body: LightningInvoiceSettledNotification = {
      memo: payload.memo ?? payload.title,
      preimage: payload.preimage ?? "",
      hash: target.topic,
      amt_paid_sat: payload.amtPaidSat ?? 0,
    };

    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/lightningInvoiceGotSettled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GroundControl push failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
    this.logger.info({ hash: body.hash, amtPaidSat: body.amt_paid_sat }, "GroundControl settlement notified");
  }
}
