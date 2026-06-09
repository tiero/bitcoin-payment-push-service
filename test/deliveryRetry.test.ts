import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwapManagerClient } from "@arkade-os/boltz-swap";
import { Registry } from "../src/registry.js";
import { attachPaymentNotifications, type PaymentService } from "../src/paymentService.js";
import type { Notifier } from "../src/notifier/types.js";
import { mockReverseSwap, silentLogger } from "./helpers.js";

function fakeManager(removeSwap: () => Promise<void>): SwapManagerClient {
  return {
    onSwapUpdate: async () => () => {},
    onSwapFailed: async () => () => {},
    onWebSocketConnected: async () => () => {},
    onWebSocketDisconnected: async () => () => {},
    removeSwap,
  } as unknown as SwapManagerClient;
}

describe("delivery reliability", () => {
  let dir: string;
  let payments: PaymentService;

  afterEach(() => {
    payments?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a claimable swap registered after inline retries exhaust, then delivers on sweep", async () => {
    dir = mkdtempSync(join(tmpdir(), "deliv-"));

    let calls = 0;
    const notify = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("push provider down");
    });
    const notifier = { notify } as unknown as Notifier;

    const removed = vi.fn(async () => {});
    const registry = new Registry(join(dir, "reg.json"), silentLogger);
    payments = await attachPaymentNotifications({
      manager: fakeManager(removed),
      registry,
      notifier,
      logger: silentLogger,
      sweepIntervalMs: 25,
      deliveryAttempts: 1,
    });

    registry.add({ swap: mockReverseSwap("s1", "transaction.mempool"), topic: "t1" });

    await vi.waitFor(
      () => {
        expect(registry.get("s1")).toBeUndefined();
        expect(calls).toBeGreaterThanOrEqual(2);
      },
      { timeout: 1500 },
    );
    expect(removed).toHaveBeenCalledWith("s1");
    expect(notify).toHaveBeenCalledTimes(calls);
  });
});
