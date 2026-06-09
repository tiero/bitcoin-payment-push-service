import {
  isReverseClaimableStatus,
  isReverseFinalStatus,
  isReverseSuccessStatus,
  type BoltzSwap,
  type BoltzSwapStatus,
  type SwapManagerClient,
} from "@arkade-os/boltz-swap";
import type { Logger } from "./logger.js";
import type { Registry, Registration } from "./registry.js";
import type { Notifier } from "./notifier/types.js";

export interface PaymentServiceDeps {
  manager: SwapManagerClient;
  registry: Registry;
  notifier: Notifier;
  logger: Logger;
  /** How often to retry delivery for claimable-but-undelivered swaps. Default 60s. */
  sweepIntervalMs?: number;
  /** Delivery attempts before leaving the swap for the next sweep. Default 3. */
  deliveryAttempts?: number;
}

export interface PaymentService {
  /** The single status-update handler. Returned so /simulate can drive it too. */
  onSwapUpdate: (swap: BoltzSwap, oldStatus: BoltzSwapStatus) => void;
  /** Stops the reconciliation sweep. */
  stop: () => void;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_DELIVERY_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wires the Boltz SwapManager's lifecycle events to push notifications.
 *
 * We push when the reverse swap becomes **claimable** (`transaction.mempool`):
 * Boltz has funded/locked the VTXO and been paid on Lightning, but the phone hasn't
 * claimed it yet. The push wakes the wallet app so it can finalize the claim.
 *
 * We *also* push on the success-terminal state (`invoice.settled`) when we haven't
 * already delivered for that swap. This future-proofs against an offline claimer
 * finalizing the receive before the wallet — or this service — ever observed the
 * claimable window: the swap can jump straight to settled, and the receiver still
 * needs to be woken that they were paid. (The mempool → settled fast path is
 * deduped: the first delivery prunes the swap, so settled finds nothing to send.)
 *
 * Delivery is robust: an in-flight guard collapses the `mempool → confirmed`
 * transition into a single send, each send is retried with backoff, and a periodic
 * sweep re-attempts claimable-or-settled-but-undelivered swaps. A delivered swap — or
 * one that reaches a *failed* terminal state without a push — is pruned from the
 * registry and the manager.
 */
export async function attachPaymentNotifications(deps: PaymentServiceDeps): Promise<PaymentService> {
  const { manager, registry, notifier, logger } = deps;
  const sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const deliveryAttempts = deps.deliveryAttempts ?? DEFAULT_DELIVERY_ATTEMPTS;

  // Swaps with a delivery currently in progress — guards against double-send.
  const inFlight = new Set<string>();

  const deliver = async (reg: Registration): Promise<void> => {
    if (inFlight.has(reg.swapId)) return;
    inFlight.add(reg.swapId);
    try {
      const suffix = reg.label ? ` (${reg.label})` : "";
      let lastErr: unknown;
      for (let attempt = 0; attempt < deliveryAttempts; attempt++) {
        try {
          const swap = reg.swap;
          // `swap.request`/`response` may be absent: the /register schema accepts a
          // minimal swap ({ id, type, status }), so read these defensively.
          await notifier.notify(
            { topic: reg.topic },
            {
              title: "Payment received",
              body: `⚡ Lightning payment received${suffix}.`,
              tags: ["zap", "moneybag"],
              priority: "high",
              memo: reg.label ?? swap.request?.description ?? "",
              preimage: swap.preimage ?? "",
              amtPaidSat: swap.request?.invoiceAmount ?? swap.response?.onchainAmount ?? 0,
            },
          );
          // Delivered: stop watching and prune.
          registry.remove(reg.swapId);
          await manager.removeSwap(reg.swapId);
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < deliveryAttempts - 1) await sleep(500 * 2 ** attempt);
        }
      }
      // Left registered & claimable — the sweep will retry it later.
      logger.error(
        { err: lastErr, swapId: reg.swapId },
        "failed to deliver push after retries; will retry on next sweep",
      );
    } finally {
      inFlight.delete(reg.swapId);
    }
  };

  const onSwapUpdate = (swap: BoltzSwap, _oldStatus: BoltzSwapStatus): void => {
    if (swap.type !== "reverse") return; // this service notifies on receives only
    const reg = registry.markStatus(swap.id, swap.status);
    if (!reg) return;

    // Funded by Boltz and not yet claimed, OR already settled (e.g. an offline
    // claimer finalized the receive before we ever saw the claimable window) →
    // either way the receiver was paid, so wake the phone. `deliver` prunes on
    // success, so a normal mempool → settled run only sends once.
    if (isReverseClaimableStatus(swap.status) || isReverseSuccessStatus(swap.status)) {
      void deliver(reg);
      return;
    }

    // Failed terminal (expired/refunded) → nothing to notify, just stop tracking it.
    if (isReverseFinalStatus(swap.status)) {
      logger.info({ swapId: swap.id, status: swap.status }, "reverse swap failed; pruning");
      registry.remove(swap.id);
      void manager.removeSwap(swap.id);
    }
  };

  // Reconciliation: re-attempt any claimable-but-still-registered swap (delivery
  // that failed all retries, or that became claimable while we were down — the
  // SwapManager dedupes an unchanged status, so it won't re-emit on restart), and
  // prune any swap that has since reached a terminal state.
  const sweep = (): void => {
    for (const reg of registry.all()) {
      if (isReverseClaimableStatus(reg.swap.status) || isReverseSuccessStatus(reg.swap.status)) {
        if (!inFlight.has(reg.swapId)) void deliver(reg);
      } else if (isReverseFinalStatus(reg.swap.status)) {
        registry.remove(reg.swapId);
        void manager.removeSwap(reg.swapId);
      }
    }
  };
  const timer = setInterval(sweep, sweepIntervalMs);
  timer.unref?.(); // don't keep the process alive for the sweep alone

  await manager.onSwapUpdate(onSwapUpdate);
  await manager.onSwapFailed((swap, error) => {
    logger.warn({ swapId: swap.id, err: error.message }, "swap failed");
  });
  await manager.onWebSocketConnected(() => logger.info("Boltz websocket connected"));
  await manager.onWebSocketDisconnected((err) =>
    logger.warn({ err: err?.message }, "Boltz websocket disconnected"),
  );

  return { onSwapUpdate, stop: () => clearInterval(timer) };
}
