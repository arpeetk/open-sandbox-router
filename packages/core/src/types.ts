/**
 * Normalized domain types shared across the gateway, adapters, and SDKs.
 *
 * These are provider-neutral. Each adapter is responsible for translating between
 * these types and its provider's native API.
 */

export type IsolationLevel = "microvm" | "gvisor" | "container";

/** Ranking used to enforce an `isolationFloor` policy (higher = stronger isolation). */
export const ISOLATION_RANK: Record<IsolationLevel, number> = {
  microvm: 3,
  gvisor: 2,
  container: 1,
};

export type SandboxStatus =
  | "provisioning"
  | "running"
  | "paused"
  | "stopped"
  | "terminated"
  | "error";

export interface ResourceSpec {
  vcpu?: number;
  memoryMB?: number;
  diskMB?: number;
  /** Number of GPUs, or a GPU type string (e.g. "a100"). Absence means CPU-only. */
  gpu?: number | string;
}

export interface PortInfo {
  port: number;
  url: string;
  protocol: "http" | "https" | "tcp";
}

/** A capability name that a caller may require or prefer at create time. */
export type CapabilityName =
  | "exec"
  | "runCode"
  | "filesystem"
  | "exposePorts"
  | "pauseResume"
  | "snapshot"
  | "persistentDisk"
  | "gpu"
  | "customImage";

export interface RoutingPreferences {
  /** Named strategy; sugar over the underlying scoring weights. */
  strategy?: "order" | "cost" | "latency" | "balanced" | `pin:${string}`;
  /** Explicit provider priority; earlier providers get a scoring bonus. */
  order?: string[];
  /** Allow-list of providers eligible for this request. */
  allow?: string[];
  /** Deny-list of providers excluded from this request. */
  deny?: string[];
  /** Region glob, e.g. "us-*", "eu-west-1". */
  region?: string;
  /** Router will never place below this isolation level. */
  isolationFloor?: IsolationLevel;
  /** Hard budget ceiling; providers estimated above this are excluded. */
  maxCostPerHourUsd?: number;
  /** When true (default), transparently try the next candidate on provider failure. */
  allowFallbacks?: boolean;
}

/** A reference to a provider-native snapshot, returned by `snapshot()` and consumed by
 * `create({ fromSnapshot })` to restore it. Opaque outside the provider that made it. */
export interface SnapshotReference {
  provider: string;
  snapshotId: string;
}

export interface CreateSandboxRequest {
  /** Portable template/image reference (see template registry). */
  template?: string;
  resources?: ResourceSpec;
  ttlSeconds?: number;
  env?: Record<string, string>;
  /** Capabilities that MUST be satisfied; unmet -> NoCompliantProvider. */
  requiredCapabilities?: CapabilityName[];
  /** Capabilities that are nice-to-have; become scoring bonuses. */
  preferredCapabilities?: CapabilityName[];
  routing?: RoutingPreferences;
  /** Per-provider passthrough options, keyed by provider id. */
  providerOptions?: Record<string, Record<string, unknown>>;
  metadata?: Record<string, string>;
  /** Idempotency key to dedupe retried create calls. */
  idempotencyKey?: string;
  /**
   * Stable, caller-chosen name for get-or-create reuse. If a live binding already exists
   * for (tenant, name), it's returned as-is with no new provisioning. Otherwise a new
   * sandbox is created and, where the provider supports native named sandboxes (e.g.
   * Vercel), the name is passed through so it's still reachable if OSR's own binding is
   * ever lost.
   */
  name?: string;
  /**
   * Restore a sandbox from a previously taken snapshot (see `SnapshotReference`). When
   * set, the router is bypassed in favor of the snapshot's own provider — but capability
   * negotiation and policy guardrails still apply, exactly like `routing.strategy:
   * "pin:<provider>"`; a snapshot on a provider that fails your requirements still throws
   * NoCompliantProvider.
   */
  fromSnapshot?: SnapshotReference;
}

/** The provider-neutral view of a sandbox returned to callers. */
export interface Sandbox {
  /** OSR-scoped stable id, independent of the provider's native id. */
  id: string;
  provider: string;
  status: SandboxStatus;
  template?: string;
  resources: ResourceSpec;
  region?: string;
  /** Capabilities granted by the resolved provider. */
  capabilities: CapabilityName[];
  ports: PortInfo[];
  metadata: Record<string, string>;
  createdAt: string;
  lastActiveAt: string;
  expiresAt?: string;
}

/** The subset of provider state an adapter returns after create/get. */
export interface ProviderSandbox {
  providerRef: string;
  status: SandboxStatus;
  region?: string;
  ports?: PortInfo[];
  expiresAt?: string;
  /** Free-form provider metadata (native id, node, etc.). */
  raw?: Record<string, unknown>;
}

export interface ExecRequest {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number };

export interface CodeRequest {
  /** Interpreter session id; the same id reuses REPL state. */
  session: string;
  code: string;
  language?: string;
  timeoutSeconds?: number;
}

export type CodeEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "result"; mime: string; data: string }
  | { type: "error"; name: string; message: string }
  | { type: "done" };

export interface FileEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

/** Normalized cost model classes across providers. */
export type CostModel =
  | { kind: "active-cpu"; usdPerVcpuHour: number; usdPerGbHourProvisioned: number }
  | { kind: "session"; usdPerHour: number }
  | { kind: "per-second-provisioned"; usdPerVcpuHour: number; usdPerGbHour: number };

export interface CostEstimate {
  /** Normalized comparable estimate for routing/reporting. NOT an invoice. */
  usdPerHour: number;
  model: CostModel["kind"];
}

export interface HealthStatus {
  provider: string;
  healthy: boolean;
  /** ISO timestamp of last observed outage, if any. */
  lastOutageAt?: string;
  /** Rolling error rate in [0,1]. */
  errorRate: number;
  /** Observed p50 cold-start in ms; falls back to manifest value. */
  coldStartMsP50?: number;
}
