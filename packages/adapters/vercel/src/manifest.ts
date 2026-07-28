import type { CapabilityManifest } from "@osr/core";

/**
 * Vercel Sandbox capability profile: microVM isolation, active-CPU billing
 * ($0.128/vCPU-hr active + provisioned memory), no GPU, exec-based (no stateful
 * code-interpreter session), ports via `sandbox.domain()`.
 *
 * Vercel's own sandboxes DO support persistence/snapshot (`persistent: true` +
 * `stop()`/`Sandbox.get()` auto-resume) and forking from a snapshot — but OSR's
 * SandboxAdapter has no `snapshot`/`restore`/`pause`/`resume` implementation for this
 * provider yet, and SandboxService doesn't expose those ops to callers regardless.
 * `pauseResume`/`snapshot` are kept `false` here so capability negotiation never lets a
 * caller believe they can request a capability nothing in the stack can actually deliver.
 * Flip these once real pause/snapshot/restore wiring lands (see @osr/core's
 * SandboxAdapter for the optional methods to implement).
 */
export const vercelManifest: CapabilityManifest = {
  provider: "vercel",
  isolation: "microvm",
  runtimes: ["node-20", "node-22", "python-3.12", "base"],
  features: {
    exec: true,
    runCode: false,
    filesystem: true,
    exposePorts: true,
    pauseResume: false,
    snapshot: false,
    persistentDisk: false,
    gpu: false,
    customImage: true,
  },
  limits: {
    maxVcpu: 32,
    maxMemoryMB: 65536,
    maxDiskMB: 10240,
    maxTtlSeconds: 5 * 3600,
    maxConcurrent: 200,
  },
  regions: ["us-east", "eu-west"],
  coldStartMsP50: 250,
  costModel: { kind: "active-cpu", usdPerVcpuHour: 0.128, usdPerGbHourProvisioned: 0.0106 },
};
