import type { CapabilityManifest } from "@osr/core";

/**
 * Modal capability profile: gVisor isolation, ~100ms cold start, strong GPU support,
 * per-second provisioned billing, tunnels for exposed ports.
 *
 * `runCode` is false: Modal is exec-based and has no built-in stateful code-interpreter
 * session (you run `python -c ...` per call), so OSR does not advertise runCode here.
 *
 * Modal's own SDK has no pause/resume verbs at all — its nearest primitive is
 * `snapshotFilesystem`, which bakes the filesystem into a reusable Image rather than
 * pausing a live sandbox. `pauseResume` stays `false`, accurate to the vendor API.
 * `snapshot` is `true`: genuinely wired via `snapshotFilesystem()` -> Image, and
 * `restore` creates a NEW sandbox from that image (`client.images.fromId` +
 * `sandboxes.create`) — see real.ts. Named get-or-create reuse uses
 * `sandboxes.fromName` with a create-on-NotFound fallback (Modal has no built-in
 * getOrCreate).
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
