import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { BoltzReverseSwap, BoltzSwapStatus } from "@arkade-os/boltz-swap";
import type { Logger } from "./logger.js";
import type { WebPushSubscription } from "./notifier/types.js";

export interface Registration {
  swapId: string;
  /**
   * Delivery target for the string-addressed providers: ntfy topic, or preimage
   * hash when using GroundControl. Absent for Web Push (see `subscription`).
   */
  topic?: string;
  /** Web Push subscription, when the wallet/PWA registered one instead of a topic. */
  subscription?: WebPushSubscription;
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
  topic?: string;
  subscription?: WebPushSubscription;
  label?: string;
  swap: BoltzReverseSwap;
}

/**
 * Stores swap-id -> registration mappings, persisted to a JSON file so that
 * registrations survive restarts and can be re-subscribed on boot.
 *
 * Lifecycle is prune-on-terminal: a registration is removed once its payment is
 * delivered or the swap fails, so the file stays bounded. Writes are atomic
 * (temp file + rename) so a crash mid-write cannot corrupt the store.
 */
export class Registry {
  private readonly byId = new Map<string, Registration>();

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const items = JSON.parse(raw) as Registration[];
      for (const item of items) this.byId.set(item.swapId, item);
      this.logger.info({ count: this.byId.size }, "loaded registrations from disk");
    } catch (err) {
      this.logger.error({ err, filePath: this.filePath }, "failed to load registrations");
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.byId.values()], null, 2));
      renameSync(tmp, this.filePath); // atomic on the same filesystem
    } catch (err) {
      this.logger.error({ err, filePath: this.filePath }, "failed to persist registrations");
    }
  }

  add(input: RegisterInput): Registration {
    const now = Date.now();
    const swapId = input.swap.id;
    const existing = this.byId.get(swapId);
    const reg: Registration = {
      swapId,
      topic: input.topic,
      subscription: input.subscription,
      label: input.label,
      swap: input.swap,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.byId.set(swapId, reg);
    this.persist();
    return reg;
  }

  get(swapId: string): Registration | undefined {
    return this.byId.get(swapId);
  }

  remove(swapId: string): boolean {
    const removed = this.byId.delete(swapId);
    if (removed) this.persist();
    return removed;
  }

  /** All registrations (the swaps still being monitored). */
  all(): Registration[] {
    return [...this.byId.values()];
  }

  /** Record a new swap status. No-ops (and skips the disk write) if unchanged. */
  markStatus(swapId: string, status: BoltzSwapStatus): Registration | undefined {
    const reg = this.byId.get(swapId);
    if (!reg) return undefined;
    if (reg.swap.status === status) return reg;
    reg.swap.status = status;
    reg.updatedAt = Date.now();
    this.persist();
    return reg;
  }
}
