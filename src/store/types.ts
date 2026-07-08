import type { BoltzReverseSwap, BoltzSwapStatus } from "@arkade-os/boltz-swap";

export interface Registration {
  swapId: string;
  /** ntfy topic, preimage hash (GroundControl), or Expo push token. */
  topic: string;
  label?: string;
  /**
   * The pending reverse swap as supplied by the wallet at registration time.
   * `swap.status` is the single source of truth for the swap's state. Re-fed to
   * the SwapManager on restart so monitoring resumes. The wallet may redact
   * `preimage` (the service never claims), keeping the secret off this box.
   */
  swap: BoltzReverseSwap;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterInput {
  topic: string;
  label?: string;
  swap: BoltzReverseSwap;
}

/**
 * Persistent swap-id -> registration store. Registrations survive restarts (so
 * monitoring can resume on boot) and are pruned on terminal state to stay
 * bounded. Implementations: {@link JsonStore} (atomic JSON file, the default)
 * and {@link SqliteStore} (better-sqlite3). Both satisfy this same contract —
 * the store test suite runs against each.
 */
export interface RegistrationStore {
  /** Open the backing store and load any persisted registrations. */
  load(): void;
  /** Upsert a registration, preserving `createdAt` for an existing swap id. */
  add(input: RegisterInput): Registration;
  get(swapId: string): Registration | undefined;
  /** @returns true if a registration existed and was removed. */
  remove(swapId: string): boolean;
  /** All registrations (the swaps still being monitored). */
  all(): Registration[];
  /**
   * Record a new swap status. No-ops (and skips the write) if unchanged;
   * returns undefined if the swap id is unknown.
   */
  markStatus(swapId: string, status: BoltzSwapStatus): Registration | undefined;
  /** Release any underlying resources (file handles, DB connection). */
  close(): void;
}
