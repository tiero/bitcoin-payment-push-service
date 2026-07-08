import { describe, it, expect, afterEach, vi } from "vitest";
import { GroundControlNotifier } from "../src/notifier/groundControlNotifier.js";
import { lastFetchRequest, silentLogger, stubFetch, stubFetchOk } from "./helpers.js";

describe("GroundControlNotifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes without error when GroundControl accepts the settlement", async () => {
    stubFetchOk();
    const notifier = new GroundControlNotifier("https://gc.example", silentLogger);

    await expect(
      notifier.notify(
        { kind: "topic" as const, topic: "ab".repeat(32) },
        { title: "Payment received", body: "settled", amtPaidSat: 5000 },
      ),
    ).resolves.toBeUndefined();
  });

  it("strips a trailing slash from the configured base URL", async () => {
    const fetchMock = stubFetchOk();
    const notifier = new GroundControlNotifier("https://gc.example/", silentLogger);

    await notifier.notify({ kind: "topic" as const, topic: "hash" }, { title: "t", body: "b" });

    expect(lastFetchRequest(fetchMock).url).toBe("https://gc.example/lightningInvoiceGotSettled");
  });

  it("uses title as memo when memo is omitted", async () => {
    const fetchMock = stubFetchOk();
    const notifier = new GroundControlNotifier("https://gc.example", silentLogger);

    await notifier.notify({ kind: "topic" as const, topic: "hash" }, { title: "Invoice paid", body: "ignored by GC" });

    const body = JSON.parse(lastFetchRequest(fetchMock).init.body as string);
    expect(body.memo).toBe("Invoice paid");
  });

  it("routes preimage hash via target.topic, not the payload body", async () => {
    const fetchMock = stubFetchOk();
    const notifier = new GroundControlNotifier("https://gc.example", silentLogger);
    const hash = "cd".repeat(32);

    await notifier.notify(
      { kind: "topic" as const, topic: hash },
      { title: "t", body: "b", memo: "m", preimage: "ee".repeat(32), amtPaidSat: 99 },
    );

    const body = JSON.parse(lastFetchRequest(fetchMock).init.body as string);
    expect(body.hash).toBe(hash);
    expect(body).not.toHaveProperty("topic");
  });

  it("surfaces the GroundControl error body in the thrown message", async () => {
    stubFetch(
      async () =>
        ({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "preimage doesnt match hash",
        }) as Response,
    );
    const notifier = new GroundControlNotifier("https://gc.example", silentLogger);

    await expect(
      notifier.notify({ kind: "topic" as const, topic: "hash" }, { title: "t", body: "b" }),
    ).rejects.toThrow("preimage doesnt match hash");
  });

  it("propagates network failures from fetch", async () => {
    stubFetch(async () => {
      throw new Error("connection reset");
    });
    const notifier = new GroundControlNotifier("https://gc.example", silentLogger);

    await expect(
      notifier.notify({ kind: "topic" as const, topic: "hash" }, { title: "t", body: "b" }),
    ).rejects.toThrow("connection reset");
  });
});
