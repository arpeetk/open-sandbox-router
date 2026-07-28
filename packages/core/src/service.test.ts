import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "./registry.js";
import { SandboxService, type CredentialProvider } from "./service.js";
import { InMemoryBindingStore } from "./binding.js";
import type { ProviderCreds } from "./adapter.js";
import { OsrError, type OsrErrorCode } from "./errors.js";

/** Assert a promise rejects with an OsrError of the given code (precise, unlike
 * pattern-matching message text which is free-form prose, not a stable contract). */
async function expectCode(promise: Promise<unknown>, code: OsrErrorCode): Promise<void> {
  try {
    await promise;
    throw new Error(`expected rejection with code ${code}, but it resolved`);
  } catch (err) {
    if (!(err instanceof OsrError)) throw err;
    expect(err.code).toBe(code);
  }
}
import type {
  CapabilityManifest,
  CapabilityName,
  CostEstimate,
  ExecEvent,
  FsOps,
  HealthStatus,
  NormalizedSpec,
  ProviderSandbox,
  SandboxAdapter,
  SnapshotRef,
} from "./index.js";

/** A richer fake than router.test.ts's, supporting pause/resume/snapshot/restore and
 * findByName-equivalent get-or-create semantics, matching a real adapter's shape. */
class LifecycleFakeAdapter implements SandboxAdapter {
  private seq = 0;
  private readonly sandboxes = new Map<string, { paused: boolean; files: Map<string, Uint8Array>; name?: string }>();
  private readonly snapshots = new Map<string, Map<string, Uint8Array>>();
  createCallCount = 0;

  constructor(
    private readonly m: CapabilityManifest,
    private readonly features: { pauseResume?: boolean; snapshot?: boolean } = {},
  ) {}

  readonly simulated = true;
  get id(): string {
    return this.m.provider;
  }
  capabilities(): CapabilityManifest {
    return { ...this.m, features: { ...this.m.features, ...this.features } };
  }
  estimateCost(_spec: NormalizedSpec): CostEstimate {
    return { usdPerHour: 0.1, model: "session" };
  }
  async health(): Promise<HealthStatus> {
    return { provider: this.id, healthy: true, errorRate: 0 };
  }
  async create(spec: NormalizedSpec): Promise<ProviderSandbox> {
    this.createCallCount++;
    // Named get-or-create fallback, mirroring the real Vercel/Modal adapters.
    if (spec.name) {
      for (const [ref, box] of this.sandboxes) {
        if (box.name === spec.name) return { providerRef: ref, status: "running" };
      }
    }
    const ref = `${this.id}-${++this.seq}`;
    this.sandboxes.set(ref, { paused: false, files: new Map(), name: spec.name });
    return {
      providerRef: ref,
      status: "running",
      expiresAt: spec.ttlSeconds ? new Date(Date.now() + spec.ttlSeconds * 1000).toISOString() : undefined,
    };
  }
  async get(ref: string): Promise<ProviderSandbox> {
    const box = this.sandboxes.get(ref);
    if (!box) throw new OsrError("NotFound", `${ref} not found`, { provider: this.id });
    return { providerRef: ref, status: box.paused ? "paused" : "running" };
  }
  async destroy(ref: string): Promise<void> {
    this.sandboxes.delete(ref);
  }
  async *exec(): AsyncIterable<ExecEvent> {
    yield { type: "exit", code: 0 };
  }
  fs: FsOps = {
    read: async (ref, path) => {
      const f = this.sandboxes.get(ref)?.files.get(path);
      if (!f) throw new OsrError("NotFound", `${path} not found`, { provider: this.id });
      return f;
    },
    write: async (ref, path, data) => {
      this.sandboxes.get(ref)?.files.set(path, data);
    },
    list: async () => [],
    remove: async () => {},
  };

  async pause(ref: string): Promise<void> {
    if (!this.features.pauseResume) throw new OsrError("CapabilityUnsupported", "no pause", { provider: this.id });
    const box = this.sandboxes.get(ref);
    if (box) box.paused = true;
  }
  async resume(ref: string): Promise<void> {
    if (!this.features.pauseResume) throw new OsrError("CapabilityUnsupported", "no resume", { provider: this.id });
    const box = this.sandboxes.get(ref);
    if (box) box.paused = false;
  }
  async snapshot(ref: string): Promise<SnapshotRef> {
    if (!this.features.snapshot) throw new OsrError("CapabilityUnsupported", "no snapshot", { provider: this.id });
    const box = this.sandboxes.get(ref);
    if (!box) throw new OsrError("NotFound", `${ref} not found`, { provider: this.id });
    const snapshotId = `${this.id}-snap-${this.snapshots.size + 1}`;
    this.snapshots.set(snapshotId, new Map(box.files));
    return { provider: this.id, snapshotId };
  }
  async restore(snap: SnapshotRef): Promise<ProviderSandbox> {
    if (!this.features.snapshot) throw new OsrError("CapabilityUnsupported", "no restore", { provider: this.id });
    const files = this.snapshots.get(snap.snapshotId);
    if (!files) throw new OsrError("NotFound", `snapshot ${snap.snapshotId} not found`, { provider: this.id });
    const ref = `${this.id}-restored-${++this.seq}`;
    this.sandboxes.set(ref, { paused: false, files: new Map(files) });
    return { providerRef: ref, status: "running" };
  }
}

function manifest(provider: string, over: Partial<Record<CapabilityName, boolean>> = {}): CapabilityManifest {
  return {
    provider,
    isolation: "microvm",
    runtimes: ["base"],
    features: {
      exec: true,
      runCode: false,
      filesystem: true,
      exposePorts: false,
      pauseResume: false,
      snapshot: false,
      persistentDisk: false,
      gpu: false,
      customImage: false,
      ...over,
    },
    limits: { maxVcpu: 8, maxMemoryMB: 8192, maxDiskMB: 20480, maxTtlSeconds: 86400, maxConcurrent: 100 },
    regions: ["us-east"],
    coldStartMsP50: 100,
    costModel: { kind: "session", usdPerHour: 0.1 },
  };
}

const noCreds: CredentialProvider = {
  async credentialsFor(): Promise<ProviderCreds> {
    return {};
  },
};

describe("named get-or-create reuse", () => {
  it("returns the same sandbox on a second create() with the same name", async () => {
    const reg = new ProviderRegistry();
    const adapter = new LifecycleFakeAdapter(manifest("p"));
    reg.register(adapter);
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });

    const first = await svc.create({ requiredCapabilities: [], name: "workspace" }, { tenant: "t" });
    const second = await svc.create({ requiredCapabilities: [], name: "workspace" }, { tenant: "t" });

    expect(second.sandbox.id).toBe(first.sandbox.id);
    expect(adapter.createCallCount).toBe(1); // provider-level create only invoked once
  });

  it("does not confuse two different names, or the same name in a different tenant", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p")));
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });

    const a = await svc.create({ requiredCapabilities: [], name: "alpha" }, { tenant: "t1" });
    const b = await svc.create({ requiredCapabilities: [], name: "beta" }, { tenant: "t1" });
    const c = await svc.create({ requiredCapabilities: [], name: "alpha" }, { tenant: "t2" });

    expect(a.sandbox.id).not.toBe(b.sandbox.id);
    expect(a.sandbox.id).not.toBe(c.sandbox.id);
  });

  it("re-creates if the named binding's underlying sandbox is gone (live NotFound check)", async () => {
    const reg = new ProviderRegistry();
    const adapter = new LifecycleFakeAdapter(manifest("p"));
    reg.register(adapter);
    const bindings = new InMemoryBindingStore();
    const svc = new SandboxService({ registry: reg, bindings, credentials: noCreds });

    const first = await svc.create({ requiredCapabilities: [], name: "workspace" }, { tenant: "t" });
    // Simulate the provider losing the sandbox out-of-band (e.g. it reaped it) without
    // OSR's own binding knowing yet.
    const binding = await bindings.get(first.sandbox.id);
    await adapter.destroy(binding!.providerRef);

    const second = await svc.create({ requiredCapabilities: [], name: "workspace" }, { tenant: "t" });
    expect(second.sandbox.id).not.toBe(first.sandbox.id); // fresh sandbox, old one was gone
    expect(adapter.createCallCount).toBe(2);
  });
});

describe("pause / resume", () => {
  it("pauses and resumes, reflecting status on the returned Sandbox", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p", { pauseResume: true }), { pauseResume: true }));
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });

    const { sandbox } = await svc.create({ requiredCapabilities: [] }, { tenant: "t" });
    const paused = await svc.pause(sandbox.id);
    expect(paused.status).toBe("paused");

    const resumed = await svc.resume(sandbox.id);
    expect(resumed.status).toBe("running");
  });

  it("throws CapabilityUnsupported when the provider has no pause/resume", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p"))); // pauseResume: false, no pause() will be exercised
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });
    const { sandbox } = await svc.create({ requiredCapabilities: [] }, { tenant: "t" });

    await expectCode(svc.pause(sandbox.id), "CapabilityUnsupported");
    await expectCode(svc.resume(sandbox.id), "CapabilityUnsupported");
  });
});

describe("snapshot / restore", () => {
  it("round-trips files through a snapshot into a NEW sandbox", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p", { snapshot: true }), { snapshot: true }));
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });

    const { sandbox } = await svc.create({ requiredCapabilities: [] }, { tenant: "t" });
    await svc.fsWrite(sandbox.id, "/data.txt", new TextEncoder().encode("hello"));
    const snap = await svc.snapshot(sandbox.id);
    expect(snap.provider).toBe("p");

    const restored = await svc.create({ requiredCapabilities: [], fromSnapshot: snap }, { tenant: "t" });
    expect(restored.sandbox.id).not.toBe(sandbox.id); // a genuinely new sandbox
    expect(restored.sandbox.provider).toBe("p");
    const content = new TextDecoder().decode(await svc.fsRead(restored.sandbox.id, "/data.txt"));
    expect(content).toBe("hello");
  });

  it("throws CapabilityUnsupported calling snapshot() on a provider without it", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p")));
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });
    const { sandbox } = await svc.create({ requiredCapabilities: [] }, { tenant: "t" });
    await expectCode(svc.snapshot(sandbox.id), "CapabilityUnsupported");
  });

  it("fromSnapshot still runs through capability negotiation (fails loud on a denied provider)", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p", { snapshot: true }), { snapshot: true }));
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });

    await expectCode(
      svc.create(
        { requiredCapabilities: [], fromSnapshot: { provider: "p", snapshotId: "whatever" }, routing: { deny: ["p"] } },
        { tenant: "t" },
      ),
      "NoCompliantProvider",
    );
  });

  it("fromSnapshot fails loud when the named provider isn't registered at all", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p", { snapshot: true }), { snapshot: true }));
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });

    await expectCode(
      svc.create({ requiredCapabilities: [], fromSnapshot: { provider: "ghost", snapshotId: "x" } }, { tenant: "t" }),
      "NoCompliantProvider",
    );
  });
});

describe("TTL reaper", () => {
  it("destroys only bindings whose TTL has elapsed, best-effort across failures", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("p")));
    const bindings = new InMemoryBindingStore();
    const svc = new SandboxService({ registry: reg, bindings, credentials: noCreds });

    const soonToExpire = await svc.create({ requiredCapabilities: [], ttlSeconds: 1 }, { tenant: "t" });
    const longLived = await svc.create({ requiredCapabilities: [], ttlSeconds: 3600 }, { tenant: "t" });

    // Simulate time passing well past the short TTL.
    const future = new Date(Date.now() + 5000);
    const result = await svc.reapExpired(future);

    expect(result.destroyed).toEqual([soonToExpire.sandbox.id]);
    expect(result.failed).toEqual([]);
    await expectCode(svc.get(soonToExpire.sandbox.id), "NotFound");
    await expect(svc.get(longLived.sandbox.id)).resolves.toBeDefined();
  });

  it("reports failures without throwing, so one bad sandbox doesn't block the rest", async () => {
    const reg = new ProviderRegistry();
    const adapter = new LifecycleFakeAdapter(manifest("p"));
    reg.register(adapter);
    const bindings = new InMemoryBindingStore();
    const svc = new SandboxService({ registry: reg, bindings, credentials: noCreds });

    const a = await svc.create({ requiredCapabilities: [], ttlSeconds: 1 }, { tenant: "t" });
    const b = await svc.create({ requiredCapabilities: [], ttlSeconds: 1 }, { tenant: "t" });

    const originalDestroy = adapter.destroy.bind(adapter);
    adapter.destroy = async (ref: string) => {
      if (ref === (await bindings.get(a.sandbox.id))!.providerRef) throw new Error("boom");
      return originalDestroy(ref);
    };

    const result = await svc.reapExpired(new Date(Date.now() + 5000));
    expect(result.destroyed).toEqual([b.sandbox.id]);
    expect(result.failed).toEqual([{ sandboxId: a.sandbox.id, error: "boom" }]);
  });
});

describe("simulated flag", () => {
  // Regression coverage for a real point of confusion: a simulated adapter uses the
  // SAME provider id as the real one ("vercel" either way), so `sandbox.simulated` is
  // the only thing that tells a caller whether they actually reached the vendor's API.
  it("is true on the created Sandbox when the bound adapter is simulated", async () => {
    const reg = new ProviderRegistry();
    reg.register(new LifecycleFakeAdapter(manifest("vercel"))); // simulated=true by construction
    const svc = new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });

    const { sandbox } = await svc.create({ requiredCapabilities: [] }, { tenant: "t" });
    expect(sandbox.simulated).toBe(true);

    const fetched = await svc.get(sandbox.id);
    expect(fetched.simulated).toBe(true); // persisted on the binding, not just the create response

    const listed = await svc.list("t");
    expect(listed[0]?.simulated).toBe(true);
  });
});
