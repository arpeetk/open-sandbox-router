/**
 * Real Modal adapter, backed by the `modal` JavaScript SDK (v0.9.x).
 *
 * Loaded via a dynamic import so the SDK stays an optional peer dependency. The v0.9 API
 * is client-instance style:
 *   new ModalClient({ tokenId, tokenSecret })
 *     .apps.fromName(name, { createIfMissing })
 *     .images.fromRegistry(tag)
 *     .sandboxes.create(app, image, params)  /  .sandboxes.fromId(id)
 *   sandbox.exec(argv, { mode: "text", stdout: "pipe", stderr: "pipe" }) -> ContainerProcess
 *   sandbox.terminate() / sandbox.tunnels()
 *
 * Auth is BYOK, resolved per-call from the tenant's credentials:
 *   OSR_MODAL_TOKEN_ID     -> tokenId
 *   OSR_MODAL_TOKEN_SECRET -> tokenSecret
 *
 * Docs: https://modal.com/docs/guide/sandboxes
 */

import type {
  CapabilityManifest,
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
import { OsrError } from "@osr/core";
import { estimateCostFromModel } from "@osr/adapter-sim";
import { modalManifest } from "./manifest.js";

const IMAGE_MAP: Record<string, string> = {
  "python-3.12": "python:3.12-slim",
  "node-20": "node:20-slim",
  base: "debian:12-slim",
};

function isNotFound(err: unknown): boolean {
  return (err as { constructor?: { name?: string } })?.constructor?.name === "NotFoundError";
}

/** Shared sandbox-create params derived from a NormalizedSpec, used by both create() and
 * restore() (which differ only in the Image they start from). */
function sandboxParams(spec: NormalizedSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {
    // Keep the sandbox alive so subsequent exec calls have something to attach to.
    command: ["sleep", "infinity"],
  };
  if (spec.name) params.name = spec.name;
  if (spec.ttlSeconds) params.timeoutMs = spec.ttlSeconds * 1000;
  if (spec.resources.vcpu) params.cpu = spec.resources.vcpu;
  if (spec.resources.memoryMB) params.memoryMiB = spec.resources.memoryMB;
  if (typeof spec.resources.gpu === "string") params.gpu = spec.resources.gpu;
  if (Array.isArray(spec.providerOptions?.["ports"])) {
    params.encryptedPorts = spec.providerOptions!["ports"] as number[];
  }
  return params;
}

function toProviderSandbox(sandbox: any, spec: NormalizedSpec): ProviderSandbox {
  return {
    providerRef: sandbox.sandboxId,
    status: "running",
    expiresAt: spec.ttlSeconds ? new Date(Date.now() + spec.ttlSeconds * 1000).toISOString() : undefined,
    raw: { sandboxId: sandbox.sandboxId },
  };
}

export interface ModalAdapterConfig {
  appName?: string;
}

export class ModalSandboxAdapter implements SandboxAdapter {
  readonly id = "modal";
  readonly simulated = false;
  private modPromise?: Promise<any>;
  private readonly appName: string;

  constructor(config: ModalAdapterConfig = {}) {
    this.appName = config.appName ?? "osr-sandboxes";
  }

  private async sdk(): Promise<any> {
    if (!this.modPromise) {
      const specifier = "modal";
      this.modPromise = import(specifier);
    }
    return this.modPromise;
  }

  private async client(creds: ProviderCreds): Promise<any> {
    const { ModalClient } = await this.sdk();
    const params: Record<string, string> = {};
    if (creds.token_id) params.tokenId = creds.token_id;
    if (creds.token_secret) params.tokenSecret = creds.token_secret;
    return new ModalClient(params);
  }

  private async connect(ref: string, creds: ProviderCreds): Promise<any> {
    const client = await this.client(creds);
    return client.sandboxes.fromId(ref);
  }

  capabilities(): CapabilityManifest {
    return modalManifest;
  }

  estimateCost(spec: NormalizedSpec): CostEstimate {
    return estimateCostFromModel(modalManifest.costModel, spec);
  }

  async health(): Promise<HealthStatus> {
    return { provider: this.id, healthy: true, errorRate: 0, coldStartMsP50: modalManifest.coldStartMsP50 };
  }

  async create(spec: NormalizedSpec, creds: ProviderCreds): Promise<ProviderSandbox> {
    const client = await this.client(creds);
    const app = await client.apps.fromName(this.appName, { createIfMissing: true });

    // Named get-or-create fallback: Modal has no built-in getOrCreate (unlike Vercel), so
    // this replicates it — try the named lookup first, and only create if it's genuinely
    // absent. This covers OSR's own binding being lost while the Modal sandbox is alive.
    if (spec.name) {
      try {
        const existing = await client.sandboxes.fromName(this.appName, spec.name);
        return toProviderSandbox(existing, spec);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }

    const imageRef =
      (typeof spec.providerOptions?.["image"] === "string" && (spec.providerOptions["image"] as string)) ||
      IMAGE_MAP[spec.template ?? "base"] ||
      IMAGE_MAP.base!;
    const image = client.images.fromRegistry(imageRef);
    const sandbox = await client.sandboxes.create(app, image, sandboxParams(spec));
    return toProviderSandbox(sandbox, spec);
  }

  async get(ref: string, creds: ProviderCreds): Promise<ProviderSandbox> {
    await this.connect(ref, creds); // throws NotFound-equivalent if it doesn't exist
    return { providerRef: ref, status: "running" };
  }

  async destroy(ref: string, creds: ProviderCreds): Promise<void> {
    const sandbox = await this.connect(ref, creds);
    await sandbox.terminate();
  }

  // NOTE: no pause()/resume() — Modal's SDK has no such primitive (the manifest's
  // pauseResume: false is accurate to the vendor API, not a gap in our wiring).

  async snapshot(ref: string, creds: ProviderCreds): Promise<SnapshotRef> {
    const sandbox = await this.connect(ref, creds);
    // Modal's snapshot bakes the filesystem into a reusable Image rather than pausing
    // this exact sandbox — "restore" means creating a NEW sandbox from that image.
    const image = await sandbox.snapshotFilesystem();
    return { provider: this.id, snapshotId: image.imageId };
  }

  async restore(snap: SnapshotRef, spec: NormalizedSpec, creds: ProviderCreds): Promise<ProviderSandbox> {
    const client = await this.client(creds);
    const app = await client.apps.fromName(this.appName, { createIfMissing: true });
    const image = await client.images.fromId(snap.snapshotId);
    const sandbox = await client.sandboxes.create(app, image, sandboxParams(spec));
    return toProviderSandbox(sandbox, spec);
  }

  async *exec(ref: string, req: ExecRequest, creds: ProviderCreds): AsyncIterable<ExecEvent> {
    const sandbox = await this.connect(ref, creds);
    const argv = [req.cmd, ...(req.args ?? [])];
    const proc = await sandbox.exec(argv, {
      mode: "text",
      stdout: "pipe",
      stderr: "pipe",
      workdir: req.cwd,
      timeoutMs: req.timeoutSeconds ? req.timeoutSeconds * 1000 : undefined,
      env: req.env,
    });
    // v0.9 ModalReadStream exposes readText(); we aggregate rather than stream per-line.
    const [stdout, stderr] = await Promise.all([proc.stdout.readText(), proc.stderr.readText()]);
    if (stdout) yield { type: "stdout", data: stdout };
    if (stderr) yield { type: "stderr", data: stderr };
    const code = await proc.wait();
    yield { type: "exit", code: typeof code === "number" ? code : 0 };
  }

  private async run(
    ref: string,
    creds: ProviderCreds,
    argv: string[],
  ): Promise<{ stdout: string; code: number }> {
    const sandbox = await this.connect(ref, creds);
    const proc = await sandbox.exec(argv, { mode: "text", stdout: "pipe", stderr: "pipe" });
    const stdout: string = await proc.stdout.readText();
    const code = await proc.wait();
    return { stdout, code: typeof code === "number" ? code : 0 };
  }

  fs: FsOps = {
    write: async (ref, path, data, creds) => {
      const b64 = Buffer.from(data).toString("base64");
      const dir = path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";
      const script = `mkdir -p '${dir}' && printf '%s' '${b64}' | base64 -d > '${path}'`;
      const { code } = await this.run(ref, creds, ["sh", "-c", script]);
      if (code !== 0) throw new OsrError("Internal", `write ${path} failed`, { provider: this.id });
    },
    read: async (ref, path, creds) => {
      const { stdout, code } = await this.run(ref, creds, ["cat", path]);
      if (code !== 0) throw new OsrError("NotFound", `${path} not found`, { provider: this.id });
      return new TextEncoder().encode(stdout);
    },
    list: async (ref, path, creds) => {
      const { stdout } = await this.run(ref, creds, ["ls", "-1p", path]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((name) => ({
          path: `${path.replace(/\/$/, "")}/${name.replace(/\/$/, "")}`,
          type: name.endsWith("/") ? ("dir" as const) : ("file" as const),
        }));
    },
    remove: async (ref, path, creds) => {
      await this.run(ref, creds, ["rm", "-rf", path]);
    },
  };

  async exposePort(ref: string, port: number, creds: ProviderCreds): Promise<PortInfo> {
    const sandbox = await this.connect(ref, creds);
    const tunnels = await sandbox.tunnels();
    const tunnel = tunnels?.[port];
    if (!tunnel?.url) {
      throw new OsrError(
        "CapabilityUnsupported",
        `port ${port} was not declared at create time (providerOptions.ports)`,
        { provider: this.id },
      );
    }
    return { port, url: tunnel.url, protocol: "https" };
  }
}
