import { describe, it, expect, afterEach, vi } from "vitest";
import { NtfyNotifier } from "../src/notifier/ntfyNotifier.js";
import { lastFetchRequest, silentLogger, stubFetch, stubFetchOk } from "./helpers.js";

describe("NtfyNotifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes without error when ntfy accepts the push", async () => {
    stubFetchOk();
    const notifier = new NtfyNotifier("https://ntfy.example", silentLogger);

    await expect(
      notifier.notify(
        { kind: "topic" as const, topic: "my-phone" },
        { title: "Payment received", body: "⚡ settled" },
      ),
    ).resolves.toBeUndefined();
  });

  it("posts to the topic path under the configured base URL", async () => {
    const fetchMock = stubFetchOk();
    const notifier = new NtfyNotifier("https://ntfy.example/", silentLogger);

    await notifier.notify({ kind: "topic" as const, topic: "my phone" }, { title: "t", body: "hello" });

    const { url, init } = lastFetchRequest(fetchMock);
    expect(url).toBe("https://ntfy.example/my%20phone");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("hello");
  });

  it("encodes emoji titles for ntfy's Title header", async () => {
    const fetchMock = stubFetchOk();
    const notifier = new NtfyNotifier("https://ntfy.example", silentLogger);
    const title = "Payment ⚡";

    await notifier.notify({ kind: "topic" as const, topic: "t" }, { title, body: "b" });

    const headers = lastFetchRequest(fetchMock).init.headers as Record<string, string>;
    expect(headers.Title).toBe(Buffer.from(title, "utf8").toString("latin1"));
    expect(headers.Title).not.toBe(title);
  });

  it("sends optional tags and priority only when provided", async () => {
    const fetchMock = stubFetchOk();
    const notifier = new NtfyNotifier("https://ntfy.example", silentLogger);

    await notifier.notify({ kind: "topic" as const, topic: "t" }, { title: "t", body: "b" });
    let headers = lastFetchRequest(fetchMock).init.headers as Record<string, string>;
    expect(headers.Tags).toBeUndefined();
    expect(headers.Priority).toBeUndefined();

    await notifier.notify(
      { kind: "topic" as const, topic: "t" },
      { title: "t", body: "b", tags: ["zap"], priority: "high" },
    );
    headers = lastFetchRequest(fetchMock).init.headers as Record<string, string>;
    expect(headers.Tags).toBe("zap");
    expect(headers.Priority).toBe("4");
  });

  it("surfaces the ntfy error body in the thrown message", async () => {
    stubFetch(
      async () =>
        ({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: async () => "rate limited",
        }) as Response,
    );
    const notifier = new NtfyNotifier("https://ntfy.example", silentLogger);

    await expect(
      notifier.notify({ kind: "topic" as const, topic: "t" }, { title: "t", body: "b" }),
    ).rejects.toThrow("rate limited");
  });
});
