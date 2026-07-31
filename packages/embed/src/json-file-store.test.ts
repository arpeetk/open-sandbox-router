import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileStore } from "./json-file-store.js";

describe("JsonFileStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "osr-json-store-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the empty value when no file exists yet", () => {
    const store = new JsonFileStore<{ n: number }>(join(dir, "missing.json"), () => ({ n: 0 }));
    expect(store.read()).toEqual({ n: 0 });
  });

  it("swallows a corrupt file rather than throwing", () => {
    const file = join(dir, "corrupt.json");
    writeFileSync(file, "{not json");
    const store = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    expect(store.read()).toEqual({ n: 0 });
  });

  it("write() then read() round-trips, including across fresh instances", () => {
    const file = join(dir, "roundtrip.json");
    const writer = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    writer.write({ n: 42 });

    const reader = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    expect(reader.read()).toEqual({ n: 42 });
  });

  it("readModifyWrite applies fn to the current value and persists the result", () => {
    const file = join(dir, "rmw.json");
    const store = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    store.readModifyWrite((cur) => ({ n: cur.n + 1 }));
    store.readModifyWrite((cur) => ({ n: cur.n + 1 }));
    expect(store.read()).toEqual({ n: 2 });
  });

  it("releases the lock and skips the write when fn throws", () => {
    const file = join(dir, "throwing.json");
    const store = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    store.write({ n: 1 });

    expect(() =>
      store.readModifyWrite(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // the failed mutation never wrote...
    expect(store.read()).toEqual({ n: 1 });
    // ...and the lock was released, so a later call isn't blocked.
    store.readModifyWrite((cur) => ({ n: cur.n + 1 }));
    expect(store.read()).toEqual({ n: 2 });
  });

  it("steals a stale lock left behind by a crashed process instead of hanging", () => {
    const file = join(dir, "stale-lock.json");
    const store = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    store.write({ n: 5 });

    // Simulate an abandoned lock: create the lock dir and backdate its mtime well
    // past the staleness threshold used internally.
    const lockPath = `${file}.lock`;
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const result = store.readModifyWrite((cur) => ({ n: cur.n + 1 }));
    expect(result).toEqual({ n: 6 });
    expect(store.read()).toEqual({ n: 6 });
    expect(existsSync(lockPath)).toBe(false); // released after the (stolen) mutation
  });

  it("readModifyWrite composes correctly under sequential interleaving (no lost updates)", () => {
    const file = join(dir, "interleave.json");
    const a = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    const b = new JsonFileStore<{ n: number }>(file, () => ({ n: 0 }));
    for (let i = 0; i < 20; i++) {
      (i % 2 === 0 ? a : b).readModifyWrite((cur) => ({ n: cur.n + 1 }));
    }
    expect(a.read()).toEqual({ n: 20 });
  });
});
