import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "./registry.js";
import { SandboxService } from "./service.js";
import { InMemoryBindingStore } from "./binding.js";
import type { ProviderCreds } from "./adapter.js";
import type { CredentialProvider } from "./service.js";

// Lightweight fake adapters (the core package must not depend on adapter packages).
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
} from "./index.js";
import { OsrError, type OsrErrorCode } from "./errors.js";

type ManifestOverride = Partial<Omit<CapabilityManifest, "features">> & {
  provider: string;
  features?: Partial<Record<CapabilityName, boolean>>;
};

function manifest(over: ManifestOverride): CapabilityManifest {
  return {
    provider: over.provider,
    isolation: over.isolation ?? "microvm",
    runtimes: over.runtimes ?? ["base"],
    features: {
      exec: true,
      runCode: true,
      filesystem: true,
      exposePorts: true,
      pauseResume: false,
      snapshot: false,
      persistentDisk: true,
      gpu: false,
      customImage: true,
      ...over.features,
    },
    limits: over.limits ?? {
      maxVcpu: 8,
      maxMemoryMB: 8192,
      maxDiskMB: 20480,
      maxTtlSeconds: 86400,
      maxConcurrent: 100,
    },
    regions: over.regions ?? ["us-east"],
    coldStartMsP50: over.coldStartMsP50 ?? 150,
    costModel: over.costModel ?? { kind: "session", usdPerHour: 0.1 },
  };
}

class FakeAdapter implements SandboxAdapter {
  private seq = 0;
  constructor(
    private readonly m: CapabilityManifest,
    private readonly failWith?: OsrErrorCode,
  ) {}
  get id(): string {
    return this.m.provider;
  }
  capabilities(): CapabilityManifest {
    return this.m;
  }
  estimateCost(_spec: NormalizedSpec): CostEstimate {
    const cm = this.m.costModel;
    return { usdPerHour: cm.kind === "session" ? cm.usdPerHour : 0.1, model: cm.kind };
  }
  async health(): Promise<HealthStatus> {
    return { provider: this.id, healthy: true, errorRate: 0 };
  }
  async create(): Promise<ProviderSandbox> {
    if (this.failWith) throw new OsrError(this.failWith, "injected", { provider: this.id });
    return { providerRef: `${this.id}-${++this.seq}`, status: "running" };
  }
  async get(ref: string): Promise<ProviderSandbox> {
    return { providerRef: ref, status: "running" };
  }
  async destroy(): Promise<void> {}
  async *exec(): AsyncIterable<ExecEvent> {
    yield { type: "exit", code: 0 };
  }
  fs: FsOps = {
    read: async () => new Uint8Array(),
    write: async () => {},
    list: async () => [],
    remove: async () => {},
  };
}

const noCreds: CredentialProvider = {
  async credentialsFor(): Promise<ProviderCreds> {
    return {};
  },
};

function service(reg: ProviderRegistry): SandboxService {
  return new SandboxService({ registry: reg, bindings: new InMemoryBindingStore(), credentials: noCreds });
}

describe("capability negotiation + routing", () => {
  it("excludes providers missing a required capability", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "cheap", features: { snapshot: false } })));
    reg.register(new FakeAdapter(manifest({ provider: "snap", features: { snapshot: true } })));
    const plan = service(reg).planRoute({ requiredCapabilities: ["snapshot"] });
    expect(plan.candidates.map((c) => c.provider)).toEqual(["snap"]);
    expect(plan.excluded.find((e) => e.provider === "cheap")).toBeTruthy();
  });

  it("cost strategy ranks the cheapest compliant provider first", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "pricey", costModel: { kind: "session", usdPerHour: 1.0 } })));
    reg.register(new FakeAdapter(manifest({ provider: "cheap", costModel: { kind: "session", usdPerHour: 0.05 } })));
    const plan = service(reg).planRoute({ requiredCapabilities: [], routing: { strategy: "cost" } });
    expect(plan.candidates[0]?.provider).toBe("cheap");
  });

  it("throws NoCompliantProvider when nothing satisfies the request", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "a", features: { gpu: false } })));
    expect(() => service(reg).planRoute({ requiredCapabilities: [], resources: { gpu: 1 } })).toThrow(
      /NoCompliantProvider|no provider/i,
    );
  });

  it("honors an isolation floor", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "weak", isolation: "container" })));
    reg.register(new FakeAdapter(manifest({ provider: "strong", isolation: "microvm" })));
    const plan = service(reg).planRoute({ requiredCapabilities: [], routing: { isolationFloor: "microvm" } });
    expect(plan.candidates.map((c) => c.provider)).toEqual(["strong"]);
  });
});

describe("create-time failover", () => {
  it("fails over from a CapacityError to the next candidate", async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "down", costModel: { kind: "session", usdPerHour: 0.01 } }), "CapacityError"));
    reg.register(new FakeAdapter(manifest({ provider: "up", costModel: { kind: "session", usdPerHour: 0.5 } })));
    const outcome = await service(reg).create({ requiredCapabilities: [], routing: { strategy: "cost" } }, { tenant: "t" });
    expect(outcome.sandbox.provider).toBe("up");
    expect(outcome.attempts[0]?.provider).toBe("down");
    expect(outcome.attempts[0]?.error).toMatch(/CapacityError/);
  });

  it("does NOT fail over on AuthError", async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "bad", costModel: { kind: "session", usdPerHour: 0.01 } }), "AuthError"));
    reg.register(new FakeAdapter(manifest({ provider: "good", costModel: { kind: "session", usdPerHour: 0.5 } })));
    await expect(
      service(reg).create({ requiredCapabilities: [], routing: { strategy: "cost" } }, { tenant: "t" }),
    ).rejects.toThrow(/AuthError|injected/);
  });
});

describe("session affinity", () => {
  it("dispatches ops to the same provider that created the sandbox", async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "home" })));
    const svc = service(reg);
    const { sandbox } = await svc.create({ requiredCapabilities: [] }, { tenant: "t" });
    const got = await svc.get(sandbox.id);
    expect(got.provider).toBe("home");
  });
});
