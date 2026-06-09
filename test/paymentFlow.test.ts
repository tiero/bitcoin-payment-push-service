import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwapManagerClient } from "@arkade-os/boltz-swap";
import { Registry } from "../src/registry.js";
import { createSwapWatcher } from "../src/swapWatcher.js";
import { attachPaymentNotifications, type PaymentService } from "../src/paymentService.js";
import { buildServer } from "../src/server.js";
import type { Notifier, NotifyPayload, NotifyTarget } from "../src/notifier/types.js";
import { flush, mockReverseSwap, silentLogger } from "./helpers.js";

/**
 * Controllable stand-in for `globalThis.WebSocket`. The real boltz-swap
 * SwapManager constructs `new globalThis.WebSocket(url)` and drives it via
 * `onopen` / `onmessage` / `send` / `readyState`, so swapping this in lets us
 * exercise the REAL SwapManager with mocked Boltz events.
 */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((msg: { data: string }) => void | Promise<void>) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }

  emitUpdate(id: string, status: string): Promise<void> | void {
    return this.onmessage?.({ data: JSON.stringify({ event: "update", args: [{ id, status }] }) });
  }
  subscribedIds(): string[] {
    return this.sent
      .map((s) => JSON.parse(s) as { op?: string; args?: string[] })
      .filter((m) => m.op === "subscribe")
      .flatMap((m) => m.args ?? []);
  }
}

describe("payment flow (real SwapManager, mocked Boltz events)", () => {
  let dir: string;
  let manager: SwapManagerClient;
  let payments: PaymentService;
  let app: ReturnType<typeof buildServer>;
  let notify: ReturnType<typeof vi.fn>;
  let notifier: Notifier;
  let originalWebSocket: unknown;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "flow-"));
    FakeWebSocket.instances = [];
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "swap.created" }) })),
    );

    notify = vi.fn(async () => {});
    notifier = { notify } as unknown as Notifier;

    const registry = new Registry(join(dir, "reg.json"), silentLogger);
    registry.load();
    manager = createSwapWatcher(
      { network: "mutinynet", apiUrl: "https://api.boltz.mutinynet.arkade.sh", pollIntervalMs: 600_000 },
      silentLogger,
    );
    payments = await attachPaymentNotifications({
      manager,
      registry,
      notifier,
      logger: silentLogger,
      sweepIntervalMs: 3_600_000,
    });

    app = buildServer({ registry, manager, simulate: payments.onSwapUpdate, logger: silentLogger });
    await app.ready();

    await manager.start([]);
    FakeWebSocket.instances[0]!.onopen?.();
  });

  afterEach(async () => {
    payments.stop();
    await manager.stop();
    await app.close();
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("end-to-end: register → Boltz funds (claimable) → one wake push → registry and manager pruned", async () => {
    const ws = FakeWebSocket.instances[0]!;
    const hash = "11".repeat(32);
    const swap = mockReverseSwap("reverse-swap-1", "swap.created", { preimageHash: hash });

    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: { swap, topic: hash, label: "1000 sats" },
    });
    expect(res.statusCode).toBe(201);

    expect(ws.subscribedIds()).toContain("reverse-swap-1");
    expect(await manager.hasSwap("reverse-swap-1")).toBe(true);

    // Nothing has been funded yet → no push.
    await flush();
    expect(notify).not.toHaveBeenCalled();

    // Boltz funds/locks the VTXO (claimable, not yet claimed) → wake the phone.
    await ws.emitUpdate("reverse-swap-1", "transaction.mempool");
    await flush();

    expect(notify).toHaveBeenCalledOnce();
    const [target, payload] = notify.mock.calls[0]! as [NotifyTarget, NotifyPayload];
    expect(target).toEqual({ topic: hash });
    expect(payload).toMatchObject({
      title: "Payment received",
      body: "⚡ Lightning payment received (1000 sats).",
      memo: "1000 sats",
      preimage: "",
      amtPaidSat: 10_000,
    });

    const list = await app.inject({ method: "GET", url: "/register" });
    expect(list.json().registrations).toHaveLength(0);
    expect(await manager.hasSwap("reverse-swap-1")).toBe(false);
  });

  it("offline claimer: jumps straight to settled (never saw mempool) → still wakes once", async () => {
    const ws = FakeWebSocket.instances[0]!;
    const hash = "22".repeat(32);
    const swap = mockReverseSwap("reverse-swap-offline", "swap.created", { preimageHash: hash });

    await app.inject({
      method: "POST",
      url: "/register",
      payload: { swap, topic: hash, label: "offline" },
    });

    // No claimable update is ever observed — an offline claimer finalized the
    // receive and the swap reports settled directly.
    await ws.emitUpdate("reverse-swap-offline", "invoice.settled");
    await flush();

    expect(notify).toHaveBeenCalledOnce();
    const [, payload] = notify.mock.calls[0]! as [NotifyTarget, NotifyPayload];
    expect(payload).toMatchObject({ title: "Payment received", memo: "offline" });

    const list = await app.inject({ method: "GET", url: "/register" });
    expect(list.json().registrations).toHaveLength(0);
    expect(await manager.hasSwap("reverse-swap-offline")).toBe(false);
  });

  it("does not double-notify across mempool → settled", async () => {
    const ws = FakeWebSocket.instances[0]!;
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { swap: mockReverseSwap("reverse-swap-settle"), topic: "phone-topic" },
    });

    // Normal path: claimable wake prunes the swap, so the later settled update
    // finds nothing to send.
    await ws.emitUpdate("reverse-swap-settle", "transaction.mempool");
    await flush();
    await ws.emitUpdate("reverse-swap-settle", "invoice.settled");
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify on Boltz failure statuses", async () => {
    const ws = FakeWebSocket.instances[0]!;
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { swap: mockReverseSwap("reverse-swap-fail"), topic: "topic" },
    });

    await ws.emitUpdate("reverse-swap-fail", "invoice.expired");
    await flush();

    expect(notify).not.toHaveBeenCalled();
    const list = await app.inject({ method: "GET", url: "/register" });
    expect(list.json().registrations).toHaveLength(0);
    expect(await manager.hasSwap("reverse-swap-fail")).toBe(false);
  });

  it("rejects invalid registration bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: { topic: "t" },
    });
    expect(res.statusCode).toBe(400);
    expect(notify).not.toHaveBeenCalled();
  });

  it("DELETE /register/:swapId stops monitoring without notifying", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { swap: mockReverseSwap("reverse-swap-del"), topic: "topic" },
    });

    const del = await app.inject({ method: "DELETE", url: "/register/reverse-swap-del" });
    expect(del.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/simulate",
      payload: { swapId: "reverse-swap-del", status: "invoice.settled" },
    });
    await flush();

    expect(notify).not.toHaveBeenCalled();
    expect(await manager.hasSwap("reverse-swap-del")).toBe(false);
  });

  it("/simulate returns 404 for unknown swap ids", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/simulate",
      payload: { swapId: "missing", status: "invoice.settled" },
    });
    expect(res.statusCode).toBe(404);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not double-notify across the mempool → confirmed transition", async () => {
    const ws = FakeWebSocket.instances[0]!;
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { swap: mockReverseSwap("reverse-swap-2"), topic: "phone-topic" },
    });

    // Both statuses are claimable; the first delivery prunes the swap so the second
    // never reaches the handler.
    await ws.emitUpdate("reverse-swap-2", "transaction.mempool");
    await flush();
    await ws.emitUpdate("reverse-swap-2", "transaction.confirmed");
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
