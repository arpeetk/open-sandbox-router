import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCliConfig } from "./cli-config.js";

describe("FileCliConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "osr-config-"));
  const file = join(dir, "config.json");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns {} when no file exists yet", () => {
    const cfg = new FileCliConfig(join(dir, "missing.json"));
    expect(cfg.read()).toEqual({});
  });

  it("persists an update across instances (simulates separate CLI processes)", () => {
    const writer = new FileCliConfig(file);
    writer.update({ mode: "local", modeSource: "explicit" });

    const reader = new FileCliConfig(file); // fresh instance = a new `osr` process
    expect(reader.read()).toEqual({ mode: "local", modeSource: "explicit" });
  });

  it("update() merges rather than replaces", () => {
    const cfg = new FileCliConfig(file);
    cfg.update({ tenant: "acme" });
    expect(cfg.read()).toEqual({ mode: "local", modeSource: "explicit", tenant: "acme" });
  });

  it("unset(mode) also clears modeSource, so a fresh probe can run", () => {
    const cfg = new FileCliConfig(file);
    cfg.unset("mode");
    const after = cfg.read();
    expect(after.mode).toBeUndefined();
    expect(after.modeSource).toBeUndefined();
    expect(after.tenant).toBe("acme"); // unrelated keys untouched
  });

  it("tracks a current sandbox per tenant, independently", () => {
    const cfg = new FileCliConfig(file);
    cfg.setCurrentSandbox("t1", "sbx_1");
    cfg.setCurrentSandbox("t2", "sbx_2");
    expect(cfg.currentSandbox("t1")).toBe("sbx_1");
    expect(cfg.currentSandbox("t2")).toBe("sbx_2");
    expect(cfg.currentSandbox("t3")).toBeUndefined();

    cfg.setCurrentSandbox("t1", "sbx_1_updated");
    expect(cfg.currentSandbox("t1")).toBe("sbx_1_updated");
    expect(cfg.currentSandbox("t2")).toBe("sbx_2"); // untouched
  });

  it("swallows a corrupt file rather than throwing", () => {
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    const cfg = new FileCliConfig(corrupt);
    expect(cfg.read()).toEqual({});
  });
});
