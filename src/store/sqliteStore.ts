import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { BoltzReverseSwap, BoltzSwapStatus } from "@arkade-os/boltz-swap";
import type { Logger } from "../logger.js";
import type { Registration, RegisterInput, RegistrationStore } from "./types.js";

/** A persisted row. `swap` holds the JSON-serialized reverse swap. */
interface Row {
  swap_id: string;
  topic: string;
  label: string | null;
  swap: string;
  created_at: number;
  updated_at: number;
}

/**
 * {@link RegistrationStore} backed by SQLite via better-sqlite3, for deployments
 * that prefer a durable database file over the JSON store. The reverse swap is
 * stored as JSON text (`swap.status` remains the single source of truth); WAL
 * mode keeps writes durable without blocking reads. Reads/writes go straight to
 * the DB, so there is no in-memory copy to diverge across restarts.
 */
export class SqliteStore implements RegistrationStore {
  private readonly db: Database.Database;

  constructor(
    filePath: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS registrations (
         swap_id    TEXT PRIMARY KEY,
         topic      TEXT NOT NULL,
         label      TEXT,
         swap       TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  load(): void {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM registrations").get() as { n: number };
    this.logger.info({ count: n }, "loaded registrations from sqlite");
  }

  private toRegistration(row: Row): Registration {
    return {
      swapId: row.swap_id,
      topic: row.topic,
      label: row.label ?? undefined,
      swap: JSON.parse(row.swap) as BoltzReverseSwap,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  add(input: RegisterInput): Registration {
    const now = Date.now();
    const swapId = input.swap.id;
    const existing = this.db
      .prepare("SELECT created_at FROM registrations WHERE swap_id = ?")
      .get(swapId) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? now;
    this.db
      .prepare(
        `INSERT INTO registrations (swap_id, topic, label, swap, created_at, updated_at)
         VALUES (@swap_id, @topic, @label, @swap, @created_at, @updated_at)
         ON CONFLICT(swap_id) DO UPDATE SET
           topic = excluded.topic, label = excluded.label,
           swap = excluded.swap, updated_at = excluded.updated_at`,
      )
      .run({
        swap_id: swapId,
        topic: input.topic,
        label: input.label ?? null,
        swap: JSON.stringify(input.swap),
        created_at: createdAt,
        updated_at: now,
      });
    return { swapId, topic: input.topic, label: input.label, swap: input.swap, createdAt, updatedAt: now };
  }

  get(swapId: string): Registration | undefined {
    const row = this.db.prepare("SELECT * FROM registrations WHERE swap_id = ?").get(swapId) as
      | Row
      | undefined;
    return row ? this.toRegistration(row) : undefined;
  }

  remove(swapId: string): boolean {
    return this.db.prepare("DELETE FROM registrations WHERE swap_id = ?").run(swapId).changes > 0;
  }

  all(): Registration[] {
    const rows = this.db.prepare("SELECT * FROM registrations").all() as Row[];
    return rows.map((row) => this.toRegistration(row));
  }

  markStatus(swapId: string, status: BoltzSwapStatus): Registration | undefined {
    const row = this.db.prepare("SELECT * FROM registrations WHERE swap_id = ?").get(swapId) as
      | Row
      | undefined;
    if (!row) return undefined;
    const reg = this.toRegistration(row);
    if (reg.swap.status === status) return reg;
    reg.swap.status = status;
    reg.updatedAt = Date.now();
    this.db
      .prepare("UPDATE registrations SET swap = ?, updated_at = ? WHERE swap_id = ?")
      .run(JSON.stringify(reg.swap), reg.updatedAt, swapId);
    return reg;
  }

  close(): void {
    this.db.close();
  }
}
