import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { BoltzSwapStatus } from "@arkade-os/boltz-swap";
import type { Logger } from "../logger.js";
import type { Registration, RegisterInput, RegistrationStore } from "./types.js";

/**
 * {@link RegistrationStore} backed by a single JSON file, kept in memory and
 * rewritten on each change. Writes are atomic (temp file + rename) so a crash
 * mid-write cannot corrupt the store; the file stays small because registrations
 * are pruned once their payment is delivered or the swap fails.
 */
export class JsonStore implements RegistrationStore {
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

  all(): Registration[] {
    return [...this.byId.values()];
  }

  markStatus(swapId: string, status: BoltzSwapStatus): Registration | undefined {
    const reg = this.byId.get(swapId);
    if (!reg) return undefined;
    if (reg.swap.status === status) return reg;
    reg.swap.status = status;
    reg.updatedAt = Date.now();
    this.persist();
    return reg;
  }

  close(): void {
    // Nothing to release: every mutation is persisted synchronously.
  }
}
