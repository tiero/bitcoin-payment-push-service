import { vi } from "vitest";
import type { BoltzReverseSwap, BoltzSwapStatus } from "@arkade-os/boltz-swap";
import type { Logger } from "../src/logger.js";

export const silentLogger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  level: "silent",
  child: () => silentLogger,
} as unknown as Logger;

export interface MockReverseSwapOptions {
  preimage?: string;
  preimageHash?: string;
  /** What the payer pays over Lightning (gross). */
  invoiceAmount?: number;
  /** What the receiver claims on-chain, net of Boltz fees. Defaults to invoiceAmount. */
  onchainAmount?: number;
  description?: string;
}

/** A minimal but type-complete pending reverse swap, as a wallet would register. */
export function mockReverseSwap(
  id = "reverse-swap-1",
  status: BoltzSwapStatus = "swap.created",
  opts: MockReverseSwapOptions = {},
): BoltzReverseSwap {
  return {
    id,
    type: "reverse",
    createdAt: Math.floor(Date.now() / 1000),
    preimage: opts.preimage ?? "",
    status,
    request: {
      claimPublicKey: "0".repeat(66),
      invoiceAmount: opts.invoiceAmount ?? 10_000,
      preimageHash: opts.preimageHash ?? "ab".repeat(32),
      ...(opts.description ? { description: opts.description } : {}),
    },
    response: {
      id,
      invoice: "lnbc100n1ptest",
      lockupAddress: "ark1test",
      onchainAmount: opts.onchainAmount ?? opts.invoiceAmount ?? 10_000,
      refundPublicKey: "0".repeat(66),
      timeoutBlockHeights: {
        refund: 100,
        unilateralClaim: 200,
        unilateralRefund: 300,
        unilateralRefundWithoutReceiver: 400,
      },
    },
  } as unknown as BoltzReverseSwap;
}

/** Stub global fetch with a controllable response factory. */
export function stubFetch(
  impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function stubFetchOk(): ReturnType<typeof vi.fn> {
  return stubFetch(async () => ({ ok: true, status: 200, text: async () => "" }) as Response);
}

export function lastFetchRequest(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit] | undefined;
  if (!call) throw new Error("fetch was not called");
  return { url: call[0], init: call[1] };
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
