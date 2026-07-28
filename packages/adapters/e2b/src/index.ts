/**
 * E2B adapter.
 *
 * Capability manifest reflects E2B's public profile: Firecracker microVM isolation,
 * ~150ms cold start, session-time billing, filesystem + code-interpreter + ports.
 *
 * NOTE: execution is currently backed by the simulated runtime. Replace SimAdapter with
 * calls to `@e2b/sdk` (Sandbox.create / commands.run / files.write / runCode) to make
 * this a production adapter. The manifest and cost model below already match E2B.
 *
 * `pauseResume: true` reflects E2B's own pause/resume API, but note that
 * SandboxService has no pause/resume passthrough for ANY provider yet (see
 * @osr/core's SandboxAdapter for the optional methods still needed end-to-end) — so
 * this capability isn't reachable through OSR today regardless of adapter.
 */

import type { CapabilityManifest, SandboxAdapter } from "@osr/core";
import { SimAdapter, type SimAdapterConfig } from "@osr/adapter-sim";

export const e2bManifest: CapabilityManifest = {
  provider: "e2b",
  isolation: "microvm",
  runtimes: ["python-3.12", "node-20", "base"],
  features: {
    exec: true,
    runCode: true,
    filesystem: true,
    exposePorts: true,
    pauseResume: true,
    snapshot: false,
    persistentDisk: true,
    gpu: false,
    customImage: true,
  },
  limits: {
    maxVcpu: 8,
    maxMemoryMB: 8192,
    maxDiskMB: 20480,
    maxTtlSeconds: 24 * 3600,
    maxConcurrent: 100,
  },
  regions: ["us-east", "eu-west"],
  coldStartMsP50: 150,
  costModel: { kind: "session", usdPerHour: 0.18 },
};

export interface E2bAdapterOptions {
  apiKey?: string;
  failCreateWith?: SimAdapterConfig["failCreateWith"];
}

export function createE2bAdapter(_opts: E2bAdapterOptions = {}): SandboxAdapter {
  // TODO: swap SimAdapter for a real E2B-backed implementation.
  return new SimAdapter({ manifest: e2bManifest, failCreateWith: _opts.failCreateWith });
}
