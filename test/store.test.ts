import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistrationStore } from "../src/store/index.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { SqliteStore } from "../src/store/sqliteStore.js";
import { silentLogger, mockReverseSwap } from "./helpers.js";

/**
 * One contract, both backends: every RegistrationStore implementation must
 * behave identically, so the same suite runs against each.
 */
const backends: Array<{ name: string; file: string; make: (path: string) => RegistrationStore }> = [
  { name: "JsonStore", file: "registrations.json", make: (p) => new JsonStore(p, silentLogger) },
  { name: "SqliteStore", file: "registrations.db", make: (p) => new SqliteStore(p, silentLogger) },
];

describe.each(backends)("$name (RegistrationStore contract)", ({ file, make }) => {
  let dir: string;
  let path: string;
  let opened: RegistrationStore[];

  const open = (p = path): RegistrationStore => {
    const store = make(p);
    opened.push(store);
    store.load();
    return store;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "store-"));
    path = join(dir, file);
    opened = [];
  });

  afterEach(() => {
    // Close first so SQLite releases its file handle (Windows can't delete an open DB).
    for (const store of opened) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds and retrieves a registration keyed by swap id", () => {
    const store = open();
    const added = store.add({ swap: mockReverseSwap("s1"), topic: "t1", label: "lbl" });
    expect(added.swapId).toBe("s1");
    expect(added.swap.status).toBe("swap.created");
    expect(store.get("s1")?.topic).toBe("t1");
    expect(store.get("s1")?.label).toBe("lbl");
  });

  it("persists and reloads (including the swap object) across instances", () => {
    const a = open();
    a.add({ swap: mockReverseSwap("s1"), topic: "t1" });
    a.add({ swap: mockReverseSwap("s2"), topic: "t2" });
    a.close();

    const b = open();
    expect(b.all()).toHaveLength(2);
    expect(b.get("s2")?.topic).toBe("t2");
    expect(b.get("s2")?.swap.type).toBe("reverse");
  });

  it("preserves createdAt when re-adding the same swap id", () => {
    const store = open();
    const first = store.add({ swap: mockReverseSwap("s1"), topic: "t1" });
    const second = store.add({ swap: mockReverseSwap("s1", "transaction.mempool"), topic: "t1b" });
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.get("s1")?.topic).toBe("t1b");
    expect(store.get("s1")?.swap.status).toBe("transaction.mempool");
  });

  it("records status on the swap and skips no-op updates", () => {
    const store = open();
    store.add({ swap: mockReverseSwap("s1"), topic: "t1" });

    store.markStatus("s1", "transaction.mempool");
    expect(store.get("s1")?.swap.status).toBe("transaction.mempool");
    const before = store.get("s1")!.updatedAt;
    const same = store.markStatus("s1", "transaction.mempool"); // unchanged -> no write
    expect(same?.updatedAt).toBe(before);
  });

  it("removes a registration", () => {
    const store = open();
    store.add({ swap: mockReverseSwap("s1"), topic: "t1" });
    expect(store.remove("s1")).toBe(true);
    expect(store.remove("s1")).toBe(false);
    expect(store.all()).toHaveLength(0);
  });

  it("load is a no-op when nothing has been persisted yet", () => {
    const store = open();
    expect(store.all()).toHaveLength(0);
  });

  it("markStatus returns undefined for unknown swap ids", () => {
    const store = open();
    expect(store.markStatus("missing", "invoice.settled")).toBeUndefined();
  });
});
