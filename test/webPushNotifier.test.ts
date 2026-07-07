import { describe, it, expect, beforeEach, vi } from "vitest";
import { silentLogger } from "./helpers.js";

// Mock the `web-push` library. vi.hoisted lets the factory (which is hoisted above
// imports) reference these safely.
const { setVapidDetails, sendNotification, MockWebPushError } = vi.hoisted(() => {
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
  return { setVapidDetails: vi.fn(), sendNotification: vi.fn(), MockWebPushError };
});

vi.mock("web-push", () => ({
  default: { setVapidDetails, sendNotification },
  WebPushError: MockWebPushError,
}));

import { WebPushNotifier } from "../src/notifier/webPushNotifier.js";

const VAPID = {
  subject: "mailto:ops@example.com",
  publicKey: "BPublicKey",
  privateKey: "PrivateKey",
};

const subscription = {
  endpoint: "https://push.example.com/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-secret" },
};

describe("WebPushNotifier", () => {
  beforeEach(() => {
    setVapidDetails.mockReset();
    sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
  });

  it("configures VAPID details from the constructor", () => {
    new WebPushNotifier(VAPID, silentLogger);
    expect(setVapidDetails).toHaveBeenCalledWith(VAPID.subject, VAPID.publicKey, VAPID.privateKey);
  });

  it("sends an encrypted push to the subscription with a JSON body", async () => {
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    await notifier.notify(
      { subscription },
      { title: "Payment received", body: "⚡ paid", tags: ["zap"], amtPaidSat: 4200 },
    );

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [sub, data, opts] = sendNotification.mock.calls[0]!;
    expect(sub).toBe(subscription);
    expect(JSON.parse(data as string)).toEqual({
      title: "Payment received",
      body: "⚡ paid",
      tags: ["zap"],
      amtPaidSat: 4200,
    });
    expect(opts).toMatchObject({ TTL: expect.any(Number) });
  });

  it("maps payload priority to the Web Push urgency header", async () => {
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    await notifier.notify({ subscription }, { title: "t", body: "b", priority: "high" });
    expect(sendNotification.mock.calls[0]![2]).toMatchObject({ urgency: "high" });

    await notifier.notify({ subscription }, { title: "t", body: "b", priority: "min" });
    expect(sendNotification.mock.calls[1]![2]).toMatchObject({ urgency: "very-low" });

    await notifier.notify({ subscription }, { title: "t", body: "b" });
    expect(sendNotification.mock.calls[2]![2]).toMatchObject({ urgency: "normal" });
  });

  it("throws when the target has no subscription", async () => {
    const notifier = new WebPushNotifier(VAPID, silentLogger);
    await expect(notifier.notify({ topic: "not-a-subscription" }, { title: "t", body: "b" })).rejects.toThrow(
      "requires target.subscription",
    );
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("surfaces a push-service rejection (e.g. 410 Gone) as a thrown error", async () => {
    sendNotification.mockRejectedValueOnce(new MockWebPushError("Gone", 410, "unsubscribed"));
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    await expect(notifier.notify({ subscription }, { title: "t", body: "b" })).rejects.toThrow(
      "web push failed: 410 unsubscribed",
    );
  });

  it("propagates non-WebPush errors unchanged", async () => {
    sendNotification.mockRejectedValueOnce(new Error("connection reset"));
    const notifier = new WebPushNotifier(VAPID, silentLogger);

    await expect(notifier.notify({ subscription }, { title: "t", body: "b" })).rejects.toThrow(
      "connection reset",
    );
  });
});
