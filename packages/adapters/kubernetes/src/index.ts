/**
 * Self-hosted Kubernetes adapter. Runs each sandbox as a Pod (with a gVisor/Kata/
 * Firecracker RuntimeClass for isolation) in your own cluster. This is the reference
 * "bring your own infra" provider: no vendor, your cost, your isolation policy.
 */

import type {
  CapabilityManifest,
  CostEstimate,
  ExecEvent,
  ExecRequest,
  FsOps,
  HealthStatus,
  NormalizedSpec,
  ProviderCreds,
  ProviderSandbox,
  SandboxAdapter,
} from "@osr/core";
import { OsrError } from "@osr/core";
import { ClientNodeKubeApi, SimulatedKubeApi, type KubeApi } from "./kube-api.js";

export const kubernetesManifest: CapabilityManifest = {
  provider: "kubernetes",
  isolation: "gvisor", // depends on the cluster RuntimeClass; microvm with Kata/Firecracker
  runtimes: ["python-3.12", "node-20", "base"],
  features: {
    exec: true,
    runCode: false,
    filesystem: true,
    exposePorts: true,
    pauseResume: false,
    snapshot: false,
    persistentDisk: true,
    gpu: true,
    customImage: true,
  },
  limits: {
    maxVcpu: 32,
    maxMemoryMB: 131072,
    maxDiskMB: 102400,
    maxTtlSeconds: 7 * 24 * 3600,
    maxConcurrent: 1000,
  },
  regions: ["self-hosted"],
  coldStartMsP50: 1200,
  // Self-hosted cost is your infra cost; expose a nominal figure so it can be scored.
  costModel: { kind: "per-second-provisioned", usdPerVcpuHour: 0.03, usdPerGbHour: 0.004 },
};

export interface KubernetesAdapterOptions {
  namespace?: string;
  defaultImage?: string;
  /** Override the K8s client (e.g. SimulatedKubeApi for tests/demo). */
  api?: KubeApi;
  /** Domain used to build preview URLs for exposed ports. */
  ingressDomain?: string;
}

const IMAGE_BY_RUNTIME: Record<string, string> = {
  "python-3.12": "python:3.12-slim",
  "node-20": "node:20-slim",
  base: "debian:12-slim",
};

export class KubernetesAdapter implements SandboxAdapter {
  readonly id = "kubernetes";
  readonly simulated: boolean;
  private readonly api: KubeApi;
  private readonly namespace: string;
  private readonly defaultImage: string;
  private readonly ingressDomain: string;

  constructor(opts: KubernetesAdapterOptions = {}) {
    this.api = opts.api ?? new ClientNodeKubeApi();
    this.simulated = this.api instanceof SimulatedKubeApi;
    this.namespace = opts.namespace ?? "osr-sandboxes";
    this.defaultImage = opts.defaultImage ?? IMAGE_BY_RUNTIME["python-3.12"]!;
    this.ingressDomain = opts.ingressDomain ?? "sandbox.local";
  }

  capabilities(): CapabilityManifest {
    return kubernetesManifest;
  }

  estimateCost(spec: NormalizedSpec): CostEstimate {
    const vcpu = spec.resources.vcpu ?? 1;
    const gb = (spec.resources.memoryMB ?? 512) / 1024;
    const cm = kubernetesManifest.costModel;
    const usdPerHour =
      cm.kind === "per-second-provisioned" ? vcpu * cm.usdPerVcpuHour + gb * cm.usdPerGbHour : 0;
    return { usdPerHour: Math.round(usdPerHour * 1e4) / 1e4, model: cm.kind };
  }

  async health(): Promise<HealthStatus> {
    return { provider: this.id, healthy: true, errorRate: 0, coldStartMsP50: 1200 };
  }

  async create(spec: NormalizedSpec, _creds: ProviderCreds): Promise<ProviderSandbox> {
    const name = `osr-${Math.random().toString(36).slice(2, 10)}`;
    const image = this.resolveImage(spec);
    await this.api.createPod({
      name,
      namespace: this.namespace,
      image,
      vcpu: spec.resources.vcpu ?? 1,
      memoryMB: spec.resources.memoryMB ?? 512,
      gpu: spec.resources.gpu,
      labels: { "osr.dev/template": spec.template ?? "base" },
      ttlSeconds: spec.ttlSeconds,
    });
    return {
      providerRef: name,
      status: "running",
      region: "self-hosted",
      expiresAt: spec.ttlSeconds
        ? new Date(Date.now() + spec.ttlSeconds * 1000).toISOString()
        : undefined,
    };
  }

  async get(ref: string, _creds: ProviderCreds): Promise<ProviderSandbox> {
    const phase = await this.api.getPodPhase(this.namespace, ref);
    if (phase === "NotFound") {
      throw new OsrError("NotFound", `pod ${ref} not found`, { provider: this.id });
    }
    return { providerRef: ref, status: phase === "Running" ? "running" : "provisioning" };
  }

  async destroy(ref: string, _creds: ProviderCreds): Promise<void> {
    await this.api.deletePod(this.namespace, ref);
  }

  async *exec(ref: string, req: ExecRequest, _creds: ProviderCreds): AsyncIterable<ExecEvent> {
    const argv = req.cmd.includes(" ") && !req.args ? ["sh", "-c", req.cmd] : [req.cmd, ...(req.args ?? [])];
    const res = await this.api.exec(this.namespace, ref, argv);
    if (res.stdout) yield { type: "stdout", data: res.stdout };
    if (res.stderr) yield { type: "stderr", data: res.stderr };
    yield { type: "exit", code: res.exitCode };
  }

  fs: FsOps = {
    read: (ref, path) => this.api.readFile(this.namespace, ref, path),
    write: (ref, path, data) => this.api.writeFile(this.namespace, ref, path, data),
    list: (ref, path) => this.api.listFiles(this.namespace, ref, path),
    remove: async (ref, path) => {
      await this.api.exec(this.namespace, ref, ["rm", "-rf", path]);
    },
  };

  async exposePort(ref: string, port: number, _creds: ProviderCreds): Promise<{
    port: number;
    url: string;
    protocol: "https";
  }> {
    // A real implementation creates a Service (+ Ingress/Gateway) targeting the Pod.
    return { port, url: `https://${ref}-${port}.${this.ingressDomain}`, protocol: "https" };
  }

  private resolveImage(spec: NormalizedSpec): string {
    if (spec.template && IMAGE_BY_RUNTIME[spec.template]) return IMAGE_BY_RUNTIME[spec.template]!;
    const opt = spec.providerOptions?.["image"];
    if (typeof opt === "string") return opt;
    return this.defaultImage;
  }
}

export function createKubernetesAdapter(opts: KubernetesAdapterOptions = {}): SandboxAdapter {
  return new KubernetesAdapter(opts);
}

export { SimulatedKubeApi, ClientNodeKubeApi } from "./kube-api.js";
export type { KubeApi } from "./kube-api.js";
