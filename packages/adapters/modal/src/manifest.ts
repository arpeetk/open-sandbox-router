import type { CapabilityManifest } from "@osr/core";

/**
 * Modal capability profile: gVisor isolation, ~100ms cold start, strong GPU support,
 * per-second provisioned billing, filesystem snapshots, tunnels for exposed ports.
 *
 * `runCode` is false: Modal is exec-based and has no built-in stateful code-interpreter
 * session (you run `python -c ...` per call), so OSR does not advertise runCode here.
 */
export const modalManifest: CapabilityManifest = {
  provider: "modal",
  isolation: "gvisor",
  runtimes: ["python-3.12", "node-20", "base"],
  features: {
    exec: true,
    runCode: false,
    filesystem: true,
    exposePorts: true,
    pauseResume: false,
    snapshot: true,
    persistentDisk: true,
    gpu: true,
    customImage: true,
  },
  limits: {
    maxVcpu: 16,
    maxMemoryMB: 32768,
    maxDiskMB: 51200,
    maxTtlSeconds: 24 * 3600,
    maxConcurrent: 100,
  },
  regions: ["us-east", "us-west"],
  coldStartMsP50: 100,
  costModel: { kind: "per-second-provisioned", usdPerVcpuHour: 0.135, usdPerGbHour: 0.024 },
};
