import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockPushSubscription, silentLogger } from "./helpers.js";
import { PermanentDeliveryError } from "../src/notifier/types.js";

// Mock the `web-push` library. vi.hoisted lets the factory (which is hoisted above
// imports) reference these safely.
const { sendNotification, MockWebPushError } = vi.hoisted(() => {
  class MockWebPushError extends Error {
    statusCode: number;
    body: string;
    constructor(message: string, statusCode: number, body = "") {
      super(message);
      this.name = "WebPushError";
      this.statusCode = statusCode;
      this.body = body;
    }
  }
  return { sendNotification: vi.fn(), MockWebPushError };
});

vi.mock("web-push", () => ({
  default: { sendNotification },
  WebPushError: MockWebPushError,
}));

import { WebPushNotifier } from "../src/notifier/webPushNotifier.js";

const VAPID = {
  subject: "mailto:ops@example.com",
  publicKey: "BPublicKey",
  privateKey: "PrivateKey",
};

const subscription = mockPushSubscription();
const target = { kind: "webpush", subscription } as const;

describe("WebPushNotifier", () => {
  beforeEach(() => {
    sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
  });

  it("sends an encrypted push to the subscription with a JSON body and per-call VAPID details", async () => {
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    await notifier.notify(target, {
      title: "Payment received",
      body: "⚡ paid",
      tags: ["zap"],
      amtPaidSat: 4200,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [sub, data, opts] = sendNotification.mock.calls[0]!;
    expect(sub).toBe(subscription);
    expect(JSON.parse(data as string)).toEqual({
      title: "Payment received",
      body: "⚡ paid",
      tags: ["zap"],
      amtPaidSat: 4200,
    });
    // VAPID identity goes per-call, not via webpush.setVapidDetails (whose
    // module-global state a second notifier instance would clobber).
    expect(opts).toMatchObject({ TTL: expect.any(Number), vapidDetails: VAPID });
  });

  it("maps payload priority to the Web Push urgency header", async () => {
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    await notifier.notify(target, { title: "t", body: "b", priority: "high" });
    expect(sendNotification.mock.calls[0]![2]).toMatchObject({ urgency: "high" });

    await notifier.notify(target, { title: "t", body: "b", priority: "min" });
    expect(sendNotification.mock.calls[1]![2]).toMatchObject({ urgency: "very-low" });

    await notifier.notify(target, { title: "t", body: "b" });
    expect(sendNotification.mock.calls[2]![2]).toMatchObject({ urgency: "normal" });
  });

  it("treats a topic target as a permanent failure", async () => {
    const notifier = new WebPushNotifier(VAPID, silentLogger);
    await expect(
      notifier.notify({ kind: "topic", topic: "not-webpush" }, { title: "t", body: "b" }),
    ).rejects.toThrow(PermanentDeliveryError);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("maps gone subscriptions (404/410) and VAPID auth rejections (401/403) to PermanentDeliveryError", async () => {
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    for (const [status, text] of [
      [410, "unsubscribed"],
      [404, "not found"],
      [403, "VapidPkHashMismatch"],
      [401, "unauthorized"],
    ] as const) {
      sendNotification.mockRejectedValueOnce(new MockWebPushError("rejected", status, text));
      await expect(notifier.notify(target, { title: "t", body: "b" })).rejects.toThrow(
        PermanentDeliveryError,
      );
    }
  });

  it("surfaces other push-service rejections as plain (retryable) errors", async () => {
    sendNotification.mockRejectedValueOnce(new MockWebPushError("Too Many", 429, "slow down"));
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    const err = await notifier.notify(target, { title: "t", body: "b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentDeliveryError);
    expect((err as Error).message).toBe("web push failed: 429 slow down");
  });

  it("propagates non-WebPush errors unchanged", async () => {
    sendNotification.mockRejectedValueOnce(new Error("connection reset"));
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    await expect(notifier.notify(target, { title: "t", body: "b" })).rejects.toThrow(
      "connection reset",
    );
  });
});
