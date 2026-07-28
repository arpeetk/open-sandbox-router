import type { CapabilityManifest } from "@osr/core";

/**
 * Vercel Sandbox capability profile: microVM isolation, active-CPU billing
 * ($0.128/vCPU-hr active + provisioned memory), no GPU, exec-based (no stateful
 * code-interpreter session), ports via `sandbox.domain()`.
 *
 * `pauseResume` and `snapshot` are genuinely wired: `pause` -> `stop()` (snapshots +
 * pauses), `resume` -> `Sandbox.get({resume: true})`, `snapshot` -> `sandbox.snapshot()`,
 * `restore` -> `Sandbox.create({source: {type: "snapshot", snapshotId}})`. See
 * `real.ts`. Named get-or-create reuse (`create({name})`) uses `Sandbox.getOrCreate`.
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
    pauseResume: true,
    snapshot: true,
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
