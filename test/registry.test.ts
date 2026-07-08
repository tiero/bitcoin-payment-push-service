import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry.js";
import { silentLogger, mockReverseSwap } from "./helpers.js";

function makeRegistry(file: string): Registry {
  return new Registry(file, silentLogger);
}

describe("Registry", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reg-"));
    file = join(dir, "registrations.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds and retrieves a registration keyed by swap id", () => {
    const reg = makeRegistry(file);
    const added = reg.add({ swap: mockReverseSwap("s1"), target: { kind: "topic" as const, topic: "t1" }, label: "lbl" });
    expect(added.swapId).toBe("s1");
    expect(added.swap.status).toBe("swap.created");
    expect(reg.get("s1")?.target).toEqual({ kind: "topic", topic: "t1" });
  });

  it("persists and reloads (including the swap object) across instances", () => {
    const a = makeRegistry(file);
    a.add({ swap: mockReverseSwap("s1"), target: { kind: "topic" as const, topic: "t1" } });
    a.add({ swap: mockReverseSwap("s2"), target: { kind: "topic" as const, topic: "t2" } });

    const b = makeRegistry(file);
    b.load();
    expect(b.all()).toHaveLength(2);
    expect(b.get("s2")?.target).toEqual({ kind: "topic", topic: "t2" });
    expect(b.get("s2")?.swap.type).toBe("reverse");
  });

  it("records status on the swap and skips no-op updates", () => {
    const reg = makeRegistry(file);
    reg.add({ swap: mockReverseSwap("s1"), target: { kind: "topic" as const, topic: "t1" } });

    reg.markStatus("s1", "transaction.mempool");
    expect(reg.get("s1")?.swap.status).toBe("transaction.mempool");
    const before = reg.get("s1")!.updatedAt;
    const same = reg.markStatus("s1", "transaction.mempool"); // unchanged -> no write
    expect(same?.updatedAt).toBe(before);
  });

  it("removes a registration", () => {
    const reg = makeRegistry(file);
    reg.add({ swap: mockReverseSwap("s1"), target: { kind: "topic" as const, topic: "t1" } });
    expect(reg.remove("s1")).toBe(true);
    expect(reg.remove("s1")).toBe(false);
    expect(reg.all()).toHaveLength(0);
  });

  it("load is a no-op when the persistence file does not exist yet", () => {
    const reg = makeRegistry(file);
    reg.load();
    expect(reg.all()).toHaveLength(0);
  });

  it("markStatus returns undefined for unknown swap ids", () => {
    const reg = makeRegistry(file);
    expect(reg.markStatus("missing", "invoice.settled")).toBeUndefined();
  });

  it("migrates legacy flat-topic entries on load and skips undeliverable ones", () => {
    const legacy = [
      // pre-union shape: flat `topic` instead of a discriminated `target`
      { swapId: "s1", topic: "t1", swap: mockReverseSwap("s1"), createdAt: 1, updatedAt: 1 },
      // no usable delivery target at all → must be skipped, not resurrected
      { swapId: "s2", swap: mockReverseSwap("s2"), createdAt: 1, updatedAt: 1 },
      // a subscription without its encryption keys can never be delivered to
      {
        swapId: "s3",
        target: { kind: "webpush", subscription: { endpoint: "https://push.example.com/x" } },
        swap: mockReverseSwap("s3"),
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    writeFileSync(file, JSON.stringify(legacy));

    const reg = makeRegistry(file);
    reg.load();

    expect(reg.all()).toHaveLength(1);
    expect(reg.get("s1")?.target).toEqual({ kind: "topic", topic: "t1" });
    expect(reg.get("s1")).not.toHaveProperty("topic");
    expect(reg.get("s2")).toBeUndefined();
    expect(reg.get("s3")).toBeUndefined();
  });
});

