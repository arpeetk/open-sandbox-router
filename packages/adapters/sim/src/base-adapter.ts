/**
 * A configurable adapter backed by SimulatedRuntime. Provider stubs (E2B, Modal,
 * Vercel) are thin configurations of this base: they differ only in their capability
 * manifest and cost model until real API wiring lands. It also supports fault injection
 * (`failCreateWith`) so the create-time failover path can be demonstrated and tested.
 */

import type {
  CapabilityManifest,
  CodeEvent,
  CodeRequest,
  CostEstimate,
  ExecEvent,
  ExecRequest,
  FsOps,
  HealthStatus,
  NormalizedSpec,
  PortInfo,
  ProviderCreds,
  ProviderSandbox,
  SandboxAdapter,
  SnapshotRef,
} from "@osr/core";
import { OsrError, type OsrErrorCode } from "@osr/core";
import { SimulatedRuntime } from "./runtime.js";
import { estimateCostFromModel } from "./cost.js";

export interface SimAdapterConfig {
  manifest: CapabilityManifest;
  /** Inject a create failure to exercise failover; consumed after one throw. */
  failCreateWith?: OsrErrorCode;
}

export class SimAdapter implements SandboxAdapter {
  readonly id: string;
  private readonly manifest: CapabilityManifest;
  private readonly runtime: SimulatedRuntime;
  private failCreateWith?: OsrErrorCode;
  private readonly snapshots = new Map<string, Map<string, Uint8Array>>();
  private snapshotSeq = 0;

  constructor(config: SimAdapterConfig) {
    this.manifest = config.manifest;
    this.id = config.manifest.provider;
    this.runtime = new SimulatedRuntime(this.id);
    this.failCreateWith = config.failCreateWith;
  }

  capabilities(): CapabilityManifest {
    return this.manifest;
  }

  estimateCost(spec: NormalizedSpec): CostEstimate {
    return estimateCostFromModel(this.manifest.costModel, spec);
  }

  async health(): Promise<HealthStatus> {
    return {
      provider: this.id,
      healthy: true,
      errorRate: 0,
      coldStartMsP50: this.manifest.coldStartMsP50,
    };
  }

  async create(spec: NormalizedSpec, _creds: ProviderCreds): Promise<ProviderSandbox> {
    if (this.failCreateWith) {
      const code = this.failCreateWith;
      this.failCreateWith = undefined; // one-shot
      throw new OsrError(code, `[${this.id} sim] injected ${code}`, { provider: this.id });
    }
    const ref = this.runtime.create();
    const ttl = spec.ttlSeconds;
    return {
      providerRef: ref,
      status: "running",
      region: this.manifest.regions[0],
      expiresAt: ttl ? new Date(Date.now() + ttl * 1000).toISOString() : undefined,
    };
  }

  async get(ref: string, _creds: ProviderCreds): Promise<ProviderSandbox> {
    if (!this.runtime.exists(ref)) {
      throw new OsrError("NotFound", `[${this.id}] ${ref} not found`, { provider: this.id });
    }
    return {
      providerRef: ref,
      status: this.runtime.isPaused(ref) ? "paused" : "running",
      region: this.manifest.regions[0],
    };
  }

  async destroy(ref: string, _creds: ProviderCreds): Promise<void> {
    this.runtime.destroy(ref);
  }

  exec(ref: string, req: ExecRequest, _creds: ProviderCreds): AsyncIterable<ExecEvent> {
    return this.runtime.exec(ref, req);
  }

  runCode(ref: string, req: CodeRequest, _creds: ProviderCreds): AsyncIterable<CodeEvent> {
    return this.runtime.runCode(ref, req.code);
  }

  fs: FsOps = {
    read: async (ref, path) => this.runtime.readFile(ref, path),
    write: async (ref, path, data) => this.runtime.writeFile(ref, path, data),
    list: async (ref, path) => this.runtime.listFiles(ref, path),
    remove: async (ref, path) => this.runtime.removeFile(ref, path),
  };

  async exposePort(ref: string, port: number, _creds: ProviderCreds): Promise<PortInfo> {
    if (!this.manifest.features.exposePorts) {
      throw new OsrError("CapabilityUnsupported", `${this.id} cannot expose ports`, {
        provider: this.id,
      });
    }
    return { port, url: `https://${ref}-${port}.sim.${this.id}.example`, protocol: "https" };
  }

  async pause(ref: string, _creds: ProviderCreds): Promise<void> {
    this.requireFeature("pauseResume", "pause");
    this.runtime.pause(ref);
  }

  async resume(ref: string, _creds: ProviderCreds): Promise<void> {
    this.requireFeature("pauseResume", "resume");
    this.runtime.resume(ref);
  }

  async snapshot(ref: string, _creds: ProviderCreds): Promise<SnapshotRef> {
    this.requireFeature("snapshot", "snapshot");
    const snapshotId = `${this.id}-snap-${++this.snapshotSeq}`;
    this.snapshots.set(snapshotId, this.runtime.exportFiles(ref));
    return { provider: this.id, snapshotId };
  }

  async restore(snap: SnapshotRef, spec: NormalizedSpec, _creds: ProviderCreds): Promise<ProviderSandbox> {
    this.requireFeature("snapshot", "restore");
    const files = this.snapshots.get(snap.snapshotId);
    if (!files) {
      throw new OsrError("NotFound", `[${this.id}] snapshot ${snap.snapshotId} not found`, { provider: this.id });
    }
    const ref = this.runtime.create(files);
    return {
      providerRef: ref,
      status: "running",
      region: this.manifest.regions[0],
      expiresAt: spec.ttlSeconds ? new Date(Date.now() + spec.ttlSeconds * 1000).toISOString() : undefined,
    };
  }

  private requireFeature(feature: "pauseResume" | "snapshot", op: string): void {
    if (!this.manifest.features[feature]) {
      throw new OsrError("CapabilityUnsupported", `${this.id} does not support ${op}`, { provider: this.id });
    }
  }
}
