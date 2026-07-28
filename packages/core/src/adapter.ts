/**
 * The provider adapter contract. Adapters are the ONLY provider-aware code in OSR;
 * the router, service, and gateway operate purely against these interfaces.
 *
 * Optional methods (`runCode`, `pause`, `snapshot`, `exposePort`, `buildTemplate`)
 * reflect real capability gaps between providers. Their presence must line up with the
 * provider's CapabilityManifest so negotiation stays honest.
 */

import type { CapabilityManifest } from "./capabilities.js";
import type {
  CodeEvent,
  CodeRequest,
  CostEstimate,
  ExecEvent,
  ExecRequest,
  FileEntry,
  HealthStatus,
  PortInfo,
  ProviderSandbox,
  ResourceSpec,
  SnapshotReference,
} from "./types.js";

/** Scoped provider credentials handed to an adapter per call (never logged). */
export interface ProviderCreds {
  [key: string]: string;
}

/** Normalized create spec after the router has resolved provider + region. */
export interface NormalizedSpec {
  template?: string;
  resources: ResourceSpec;
  ttlSeconds?: number;
  env?: Record<string, string>;
  region?: string;
  providerOptions?: Record<string, unknown>;
  /** Caller-chosen stable name, passed through for providers with native named-sandbox
   * support (e.g. Vercel's getOrCreate, Modal's fromName) so reuse survives even if
   * OSR's own binding is lost. */
  name?: string;
}

export interface FsOps {
  read(ref: string, path: string, creds: ProviderCreds): Promise<Uint8Array>;
  write(ref: string, path: string, data: Uint8Array, creds: ProviderCreds): Promise<void>;
  list(ref: string, path: string, creds: ProviderCreds): Promise<FileEntry[]>;
  remove(ref: string, path: string, creds: ProviderCreds): Promise<void>;
}

/** Alias kept for the adapter contract's established name; canonical shape lives in
 * types.ts as `SnapshotReference` (also used by `CreateSandboxRequest.fromSnapshot`). */
export type SnapshotRef = SnapshotReference;

export interface TemplateSpec {
  name: string;
  base: string;
  setup?: string[];
  env?: Record<string, string>;
  workdir?: string;
  expose?: number[];
}

export interface ProviderTemplateRef {
  provider: string;
  template: string;
  providerRef: string;
  contentHash: string;
}

export interface SandboxAdapter {
  readonly id: string;

  /** Static + probed capability manifest used by negotiation and scoring. */
  capabilities(): CapabilityManifest;

  /** Normalized cost estimate for the given spec (comparable across providers). */
  estimateCost(spec: NormalizedSpec): CostEstimate;

  /** Liveness/health signal consumed by the router's outage avoidance. */
  health(): Promise<HealthStatus>;

  // ---- Lifecycle -----------------------------------------------------------
  create(spec: NormalizedSpec, creds: ProviderCreds): Promise<ProviderSandbox>;
  get(ref: string, creds: ProviderCreds): Promise<ProviderSandbox>;
  destroy(ref: string, creds: ProviderCreds): Promise<void>;

  // ---- Execution -----------------------------------------------------------
  exec(ref: string, req: ExecRequest, creds: ProviderCreds): AsyncIterable<ExecEvent>;
  runCode?(ref: string, req: CodeRequest, creds: ProviderCreds): AsyncIterable<CodeEvent>;

  // ---- Filesystem ----------------------------------------------------------
  fs: FsOps;

  // ---- Networking ----------------------------------------------------------
  exposePort?(ref: string, port: number, creds: ProviderCreds): Promise<PortInfo>;

  // ---- Advanced (capability-gated) ----------------------------------------
  pause?(ref: string, creds: ProviderCreds): Promise<void>;
  resume?(ref: string, creds: ProviderCreds): Promise<void>;
  snapshot?(ref: string, creds: ProviderCreds): Promise<SnapshotRef>;
  restore?(snap: SnapshotRef, spec: NormalizedSpec, creds: ProviderCreds): Promise<ProviderSandbox>;

  // ---- Portable templates --------------------------------------------------
  buildTemplate?(spec: TemplateSpec, creds: ProviderCreds): Promise<ProviderTemplateRef>;
}
