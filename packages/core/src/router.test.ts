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

/** A call log shared across FakeAdapter instances so tests can prove WHICH adapter
 * actually served a given operation (the crux of a real session-affinity proof). */
type CallLog = { op: string; provider: string }[];

class FakeAdapter implements SandboxAdapter {
  private seq = 0;
  constructor(
    private readonly m: CapabilityManifest,
    private readonly failWith?: OsrErrorCode,
    private readonly log?: CallLog,
  ) {}
  readonly simulated = true;
  get id(): string {
    return this.m.provider;
  }
  private record(op: string): void {
    this.log?.push({ op, provider: this.id });
  }
  capabilities(): CapabilityManifest {
    return this.m;
  }
  estimateCost(_spec: NormalizedSpec): CostEstimate {
    const cm = this.m.costModel;
    return { usdPerHour: cm.kind === "session" ? cm.usdPerHour : 0.1, model: cm.kind };
  }
  async health(): Promise<HealthStatus> {
    return { provider: this.id, healthy: true, errorRate: 0, coldStartMsP50: this.m.coldStartMsP50 };
  }
  async create(): Promise<ProviderSandbox> {
    this.record("create");
    if (this.failWith) throw new OsrError(this.failWith, "injected", { provider: this.id });
    return { providerRef: `${this.id}-${++this.seq}`, status: "running" };
  }
  async get(ref: string): Promise<ProviderSandbox> {
    this.record("get");
    return { providerRef: ref, status: "running" };
  }
  async destroy(): Promise<void> {
    this.record("destroy");
  }
  async *exec(): AsyncIterable<ExecEvent> {
    this.record("exec");
    yield { type: "exit", code: 0 };
  }
  fs: FsOps = {
    read: async () => {
      this.record("fs.read");
      return new Uint8Array();
    },
    write: async () => {
      this.record("fs.write");
    },
    list: async () => {
      this.record("fs.list");
      return [];
    },
    remove: async () => {
      this.record("fs.remove");
    },
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

  it("stays pinned to the original provider even when a cheaper one is registered later", async () => {
    const log: CallLog = [];
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "original", costModel: { kind: "session", usdPerHour: 0.5 } }), undefined, log));
    const svc = service(reg);

    const { sandbox } = await svc.create({ requiredCapabilities: [], routing: { strategy: "cost" } }, { tenant: "t" });
    expect(sandbox.provider).toBe("original");

    // A far cheaper provider shows up AFTER the sandbox already exists. If routing were
    // re-evaluated on every op, later calls would (wrongly) prefer this one.
    reg.register(new FakeAdapter(manifest({ provider: "much-cheaper", costModel: { kind: "session", usdPerHour: 0.01 } }), undefined, log));

    await svc.get(sandbox.id);
    await svc.fsWrite(sandbox.id, "/x", new Uint8Array());
    await svc.fsRead(sandbox.id, "/x");
    for await (const _ of svc.exec(sandbox.id, { cmd: "true" })) void _;
    await svc.destroy(sandbox.id);

    // Every single op after create must have hit "original" — never the cheaper newcomer.
    expect(log.map((c) => c.provider)).toEqual(Array(log.length).fill("original"));
    expect(log.map((c) => c.op)).toEqual(["create", "get", "fs.write", "fs.read", "exec", "destroy"]);
  });

  it("a second sandbox created afterward IS free to land on the new cheaper provider", async () => {
    // Contrast case: session affinity pins existing sandboxes, but routing for a NEW
    // create is re-evaluated fresh against the current registry.
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "original", costModel: { kind: "session", usdPerHour: 0.5 } })));
    const svc = service(reg);
    const first = await svc.create({ requiredCapabilities: [], routing: { strategy: "cost" } }, { tenant: "t" });
    reg.register(new FakeAdapter(manifest({ provider: "much-cheaper", costModel: { kind: "session", usdPerHour: 0.01 } })));
    const second = await svc.create({ requiredCapabilities: [], routing: { strategy: "cost" } }, { tenant: "t" });

    expect(first.sandbox.provider).toBe("original");
    expect(second.sandbox.provider).toBe("much-cheaper");
  });
});

describe("routing strategies", () => {
  it("latency strategy ranks the fastest cold-start compliant provider first", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "slow", coldStartMsP50: 2500 })));
    reg.register(new FakeAdapter(manifest({ provider: "fast", coldStartMsP50: 90 })));
    const plan = service(reg).planRoute({ requiredCapabilities: [], routing: { strategy: "latency" } });
    expect(plan.candidates[0]?.provider).toBe("fast");
  });

  it("order strategy respects the explicit priority list over raw cost/latency", () => {
    const reg = new ProviderRegistry();
    // "better" wins on every raw metric; "worse" is explicitly prioritized via order.
    reg.register(new FakeAdapter(manifest({ provider: "better", costModel: { kind: "session", usdPerHour: 0.01 }, coldStartMsP50: 50 })));
    reg.register(new FakeAdapter(manifest({ provider: "worse", costModel: { kind: "session", usdPerHour: 5 }, coldStartMsP50: 3000 })));
    const plan = service(reg).planRoute({
      requiredCapabilities: [],
      routing: { strategy: "order", order: ["worse", "better"] },
    });
    expect(plan.candidates[0]?.provider).toBe("worse");
  });

  it("balanced (default) strategy blends factors and can disagree with cost-only ranking", () => {
    // A: mid-cost but very fast. B: much cheaper but very slow.
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "A", costModel: { kind: "session", usdPerHour: 0.4 }, coldStartMsP50: 50 })));
    reg.register(new FakeAdapter(manifest({ provider: "B", costModel: { kind: "session", usdPerHour: 0.1 }, coldStartMsP50: 2500 })));

    const costPlan = service(reg).planRoute({ requiredCapabilities: [], routing: { strategy: "cost" } });
    expect(costPlan.candidates[0]?.provider).toBe("B"); // cheapest wins under `cost`

    const defaultPlan = service(reg).planRoute({ requiredCapabilities: [] }); // no strategy -> balanced
    expect(defaultPlan.candidates[0]?.provider).toBe("A"); // balanced weighs latency enough to flip the winner
  });

  it("pin:<provider> selects that provider even when it is not the best-scoring candidate", async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "cheap", costModel: { kind: "session", usdPerHour: 0.01 } })));
    reg.register(new FakeAdapter(manifest({ provider: "pinned", costModel: { kind: "session", usdPerHour: 9 } })));
    const outcome = await service(reg).create(
      { requiredCapabilities: [], routing: { strategy: "pin:pinned" } },
      { tenant: "t" },
    );
    expect(outcome.sandbox.provider).toBe("pinned");
  });

  it("pin:<provider> still fails loud when the pinned provider lacks a required capability", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "no-gpu", features: { gpu: false } })));
    expect(() =>
      service(reg).planRoute({
        requiredCapabilities: ["gpu"],
        resources: { gpu: 1 },
        routing: { strategy: "pin:no-gpu" },
      }),
    ).toThrow(/NoCompliantProvider|does not satisfy/i);
  });

  it("pin:<provider> still respects a hard cost ceiling", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "pricey", costModel: { kind: "session", usdPerHour: 5 } })));
    expect(() =>
      service(reg).planRoute({
        requiredCapabilities: [],
        routing: { strategy: "pin:pricey", maxCostPerHourUsd: 1 },
      }),
    ).toThrow(/NoCompliantProvider|exceeds the cost ceiling/i);
  });

  it("pin:<provider> cannot bypass a deny-list policy guardrail", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "blocked" })));
    expect(() =>
      service(reg).planRoute({
        requiredCapabilities: [],
        routing: { strategy: "pin:blocked", deny: ["blocked"] },
      }),
    ).toThrow(/NoCompliantProvider|does not satisfy/i);
  });
});

describe("guardrails", () => {
  it("allow-list restricts the candidate set", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "a" })));
    reg.register(new FakeAdapter(manifest({ provider: "b" })));
    const plan = service(reg).planRoute({ requiredCapabilities: [], routing: { allow: ["a"] } });
    expect(plan.candidates.map((c) => c.provider)).toEqual(["a"]);
    expect(plan.excluded.find((e) => e.provider === "b")?.reason).toMatch(/allow-list/);
  });

  it("deny-list excludes a provider", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "a" })));
    reg.register(new FakeAdapter(manifest({ provider: "b" })));
    const plan = service(reg).planRoute({ requiredCapabilities: [], routing: { deny: ["b"] } });
    expect(plan.candidates.map((c) => c.provider)).toEqual(["a"]);
    expect(plan.excluded.find((e) => e.provider === "b")?.reason).toMatch(/deny-list/);
  });

  it("region glob excludes providers outside the requested region", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "us", regions: ["us-east", "us-west"] })));
    reg.register(new FakeAdapter(manifest({ provider: "eu", regions: ["eu-west"] })));
    const plan = service(reg).planRoute({ requiredCapabilities: [], routing: { region: "us-*" } });
    expect(plan.candidates.map((c) => c.provider)).toEqual(["us"]);
    expect(plan.excluded.find((e) => e.provider === "eu")?.reason).toMatch(/region/);
  });

  it("maxCostPerHourUsd filters out providers over budget", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "cheap", costModel: { kind: "session", usdPerHour: 0.1 } })));
    reg.register(new FakeAdapter(manifest({ provider: "pricey", costModel: { kind: "session", usdPerHour: 5 } })));
    const plan = service(reg).planRoute({ requiredCapabilities: [], routing: { maxCostPerHourUsd: 1 } });
    expect(plan.candidates.map((c) => c.provider)).toEqual(["cheap"]);
  });

  it("throws NoCompliantProvider when every candidate exceeds the cost ceiling", () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "pricey", costModel: { kind: "session", usdPerHour: 5 } })));
    expect(() =>
      service(reg).planRoute({ requiredCapabilities: [], routing: { maxCostPerHourUsd: 1 } }),
    ).toThrow(/NoCompliantProvider|cost ceiling/i);
  });

  it("allowFallbacks: false disables create-time failover", async () => {
    const reg = new ProviderRegistry();
    reg.register(new FakeAdapter(manifest({ provider: "down", costModel: { kind: "session", usdPerHour: 0.01 } }), "CapacityError"));
    reg.register(new FakeAdapter(manifest({ provider: "up", costModel: { kind: "session", usdPerHour: 0.5 } })));
    await expect(
      service(reg).create(
        { requiredCapabilities: [], routing: { strategy: "cost", allowFallbacks: false } },
        { tenant: "t" },
      ),
    ).rejects.toThrow(/CapacityError|injected/);
  });
});
