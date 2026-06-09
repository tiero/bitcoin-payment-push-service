import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwapManagerClient } from "@arkade-os/boltz-swap";
import { Registry } from "../src/registry.js";
import { attachPaymentNotifications, type PaymentService } from "../src/paymentService.js";
import type { Notifier, NotifyPayload, NotifyTarget } from "../src/notifier/types.js";
import { flush, mockReverseSwap, silentLogger } from "./helpers.js";

function fakeManager(removeSwap = vi.fn(async () => {})): SwapManagerClient {
  return {
    onSwapUpdate: async () => () => {},
    onSwapFailed: async () => () => {},
    onWebSocketConnected: async () => () => {},
    onWebSocketDisconnected: async () => () => {},
    removeSwap,
  } as unknown as SwapManagerClient;
}

describe("attachPaymentNotifications", () => {
  let dir: string;
  let payments: PaymentService;
  let registry: Registry;
  let notify: ReturnType<typeof vi.fn>;
  let notifier: Notifier;
  let removeSwap: ReturnType<typeof vi.fn>;

  afterEach(() => {
    payments?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(
    opts: { sweepIntervalMs?: number; deliveryAttempts?: number } = {},
  ): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), "pay-"));
    registry = new Registry(join(dir, "reg.json"), silentLogger);
    removeSwap = vi.fn(async () => {});
    notify = vi.fn(async () => {});
    notifier = { notify } as unknown as Notifier;
    payments = await attachPaymentNotifications({
      manager: fakeManager(removeSwap),
      registry,
      notifier,
      logger: silentLogger,
      sweepIntervalMs: opts.sweepIntervalMs ?? 3_600_000,
      deliveryAttempts: opts.deliveryAttempts ?? 3,
    });
  }

  it("builds the notify payload from the registration and swap on the claimable status", async () => {
    await start();
    const hash = "fe".repeat(32);
    registry.add({
      swap: mockReverseSwap("s1", "swap.created", {
        preimageHash: hash,
        invoiceAmount: 42_000,
        description: "latte",
      }),
      topic: hash,
      label: "42k sats",
    });

    // transaction.mempool = Boltz funded the VTXO, not yet claimed → wake the phone.
    payments.onSwapUpdate(mockReverseSwap("s1", "transaction.mempool"), "swap.created");
    await flush();

    expect(notify).toHaveBeenCalledOnce();
    const [target, payload] = notify.mock.calls[0]! as [NotifyTarget, NotifyPayload];
    expect(target).toEqual({ topic: hash });
    expect(payload).toMatchObject({
      title: "Payment received",
      body: "⚡ Lightning payment received (42k sats).",
      memo: "42k sats",
      preimage: "",
      amtPaidSat: 42_000,
      tags: ["zap", "moneybag"],
      priority: "high",
    });
  });

  it("retries inline before leaving the swap registered for the sweep", async () => {
    dir = mkdtempSync(join(tmpdir(), "pay-"));
    registry = new Registry(join(dir, "reg.json"), silentLogger);
    removeSwap = vi.fn(async () => {});
    let attempts = 0;
    notify = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
    });
    notifier = { notify } as unknown as Notifier;
    payments = await attachPaymentNotifications({
      manager: fakeManager(removeSwap),
      registry,
      notifier,
      logger: silentLogger,
      deliveryAttempts: 3,
      sweepIntervalMs: 3_600_000,
    });

    registry.add({ swap: mockReverseSwap("s1", "transaction.mempool"), topic: "t1" });
    payments.onSwapUpdate(mockReverseSwap("s1", "transaction.mempool"), "swap.created");

    // Inline retries back off (500ms, 1s) between attempts.
    await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 3000 });
    expect(registry.get("s1")).toBeUndefined();
    expect(removeSwap).toHaveBeenCalledWith("s1");
  });

  it("prunes failed reverse swaps without notifying", async () => {
    await start();
    registry.add({ swap: mockReverseSwap("s1"), topic: "t1" });

    payments.onSwapUpdate(mockReverseSwap("s1", "invoice.expired"), "swap.created");
    await flush();

    expect(notify).not.toHaveBeenCalled();
    expect(registry.get("s1")).toBeUndefined();
    expect(removeSwap).toHaveBeenCalledWith("s1");
  });

  it("wakes once on settled when the claimable window was never observed (offline claimer)", async () => {
    await start();
    registry.add({ swap: mockReverseSwap("s1"), topic: "t1" });

    // We never saw the claimable window (e.g. an offline claimer finalized the
    // receive, or the process was down) and the next update we observe is already
    // invoice.settled — the receiver was still paid, so wake them, then prune.
    payments.onSwapUpdate(mockReverseSwap("s1", "invoice.settled"), "swap.created");
    await flush();

    expect(notify).toHaveBeenCalledOnce();
    expect(registry.get("s1")).toBeUndefined();
    expect(removeSwap).toHaveBeenCalledWith("s1");
  });

  it("ignores updates for swaps that were never registered", async () => {
    await start();

    payments.onSwapUpdate(mockReverseSwap("unknown", "transaction.mempool"), "swap.created");
    await flush();

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not start a second delivery while the first is still in flight", async () => {
    dir = mkdtempSync(join(tmpdir(), "pay-"));
    registry = new Registry(join(dir, "reg.json"), silentLogger);
    removeSwap = vi.fn(async () => {});
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    notify = vi.fn(async () => {
      await gate;
    });
    notifier = { notify } as unknown as Notifier;
    payments = await attachPaymentNotifications({
      manager: fakeManager(removeSwap),
      registry,
      notifier,
      logger: silentLogger,
      sweepIntervalMs: 3_600_000,
    });

    registry.add({ swap: mockReverseSwap("s1"), topic: "t1" });
    // mempool then confirmed are both claimable; the in-flight guard must collapse
    // them into a single send.
    payments.onSwapUpdate(mockReverseSwap("s1", "transaction.mempool"), "swap.created");
    payments.onSwapUpdate(mockReverseSwap("s1", "transaction.confirmed"), "transaction.mempool");
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);

    unblock();
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(registry.get("s1")).toBeUndefined();
  });
});
