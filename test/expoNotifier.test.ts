import { describe, it, expect, afterEach, vi } from "vitest";
import { ExpoNotifier } from "../src/notifier/expoNotifier.js";
import { silentLogger, stubFetch, lastFetchRequest } from "./helpers.js";

const okTicket = async () =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ data: { status: "ok", id: "ticket-1" } }),
    text: async () => "",
  }) as Response;

describe("ExpoNotifier", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs an Expo push message addressed to the push token", async () => {
    const fetchMock = stubFetch(okTicket);
    const notifier = new ExpoNotifier(undefined, silentLogger);

    await notifier.notify(
      { topic: "ExponentPushToken[abc]" },
      { title: "Payment received", body: "⚡ received (1000 sats).", priority: "high", amtPaidSat: 1000, memo: "coffee" },
    );

    const { url, init } = lastFetchRequest(fetchMock);
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("ExponentPushToken[abc]");
    expect(body.title).toBe("Payment received");
    expect(body.priority).toBe("high");
    expect(body.data).toMatchObject({ amtPaidSat: 1000, memo: "coffee" });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("adds a bearer Authorization header when an access token is configured", async () => {
    const fetchMock = stubFetch(okTicket);
    const notifier = new ExpoNotifier("secret-token", silentLogger);

    await notifier.notify({ topic: "ExponentPushToken[abc]" }, { title: "t", body: "b" });

    const { init } = lastFetchRequest(fetchMock);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("throws on a non-ok HTTP response", async () => {
    stubFetch(
      async () =>
        ({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({}), text: async () => "bad token" }) as Response,
    );
    const notifier = new ExpoNotifier(undefined, silentLogger);
    await expect(notifier.notify({ topic: "x" }, { title: "t", body: "b" })).rejects.toThrow(/Expo push failed/);
  });

  it("throws when Expo returns a per-message error ticket", async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ data: { status: "error", message: "DeviceNotRegistered" } }),
          text: async () => "",
        }) as Response,
    );
    const notifier = new ExpoNotifier(undefined, silentLogger);
    await expect(notifier.notify({ topic: "x" }, { title: "t", body: "b" })).rejects.toThrow(
      /Expo push ticket error: DeviceNotRegistered/,
    );
  });
});
