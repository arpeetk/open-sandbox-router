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
    return { providerRef: ref, status: "running", region: this.manifest.regions[0] };
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
}
