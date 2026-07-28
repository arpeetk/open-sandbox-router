import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding } from "@osr/core";
import { FileBindingStore } from "./file-binding-store.js";

function binding(id: string, over: Partial<Binding> = {}): Binding {
  const now = new Date().toISOString();
  return {
    sandboxId: id,
    provider: "modal",
    providerRef: `ref-${id}`,
    tenant: "t1",
    resources: {},
    capabilities: [],
    status: "running",
    metadata: {},
    createdAt: now,
    lastActiveAt: now,
    ...over,
  };
}

describe("FileBindingStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "osr-bindings-"));
  const file = join(dir, "bindings.json");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("persists a binding across store instances (simulates separate CLI processes)", async () => {
    const writer = new FileBindingStore(file);
    await writer.create(binding("sbx_1", { provider: "vercel", providerRef: "vref" }));

    const reader = new FileBindingStore(file); // fresh instance = a new `osr` process
    const got = await reader.get("sbx_1");
    expect(got?.provider).toBe("vercel");
    expect(got?.providerRef).toBe("vref");
  });

  it("updates, lists by tenant, and deletes", async () => {
    const s = new FileBindingStore(file);
    await s.create(binding("sbx_2", { tenant: "t2" }));
    await s.update("sbx_2", { status: "stopped" });
    expect((await s.get("sbx_2"))?.status).toBe("stopped");
    expect((await s.list("t2")).map((b) => b.sandboxId)).toEqual(["sbx_2"]);

    await s.delete("sbx_2");
    expect(await s.get("sbx_2")).toBeUndefined();
  });

  it("finds by idempotency key and reports expired bindings", async () => {
    const s = new FileBindingStore(file);
    await s.create(binding("sbx_3", { idempotencyKey: "job-9" }));
    expect((await s.findByIdempotencyKey("t1", "job-9"))?.sandboxId).toBe("sbx_3");

    await s.create(binding("sbx_old", { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect((await s.expired()).map((b) => b.sandboxId)).toContain("sbx_old");
  });
});
