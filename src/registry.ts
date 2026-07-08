import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { BoltzReverseSwap, BoltzSwapStatus } from "@arkade-os/boltz-swap";
import type { Logger } from "./logger.js";
import type { NotifyTarget } from "./notifier/types.js";

export interface Registration {
  swapId: string;
  /**
   * Where to deliver the push: a topic (ntfy) / preimage hash (GroundControl),
   * or a Web Push subscription. Discriminated so a registration without a
   * usable delivery target is unrepresentable.
   */
  target: NotifyTarget;
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
  target: NotifyTarget;
  label?: string;
  swap: BoltzReverseSwap;
}

/** On-disk shape: current entries carry `target`; legacy ones a bare `topic`. */
type PersistedRegistration = Registration & { topic?: string };

/** Accepts current and legacy persisted shapes; undefined if no usable target. */
function toTarget(item: PersistedRegistration): NotifyTarget | undefined {
  const target = item.target as NotifyTarget | undefined;
  if (target?.kind === "topic" && target.topic) return target;
  // A subscription without its keys can never be delivered to (web-push requires
  // p256dh/auth for payload encryption) — treat it like a missing target.
  if (
    target?.kind === "webpush" &&
    target.subscription?.endpoint &&
    target.subscription.keys?.p256dh &&
    target.subscription.keys?.auth
  ) {
    return target;
  }
  // Legacy flat `topic` from before NotifyTarget became a discriminated union.
  if (typeof item.topic === "string" && item.topic) return { kind: "topic", topic: item.topic };
  return undefined;
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
      const items = JSON.parse(raw) as PersistedRegistration[];
      for (const item of items) {
        const target = toTarget(item);
        if (!item.swapId || !item.swap || !target) {
          this.logger.warn({ swapId: item.swapId }, "skipping persisted registration without a delivery target");
          continue;
        }
        const { topic: _topic, ...rest } = item;
        this.byId.set(item.swapId, { ...rest, target });
      }
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
      target: input.target,
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
