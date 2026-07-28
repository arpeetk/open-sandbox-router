/**
 * Real Vercel Sandbox adapter, backed by `@vercel/sandbox`.
 *
 * The SDK is loaded via a dynamic import (non-literal specifier) so it stays an optional
 * peer dependency and requires no type resolution here. Sandboxes are identified by their
 * `name`, which we use as the OSR providerRef and reconnect with via `Sandbox.get`.
 *
 * Auth is BYOK, resolved per-call from the tenant's credentials:
 *   OSR_VERCEL_TOKEN       -> token
 *   OSR_VERCEL_TEAM_ID     -> teamId
 *   OSR_VERCEL_PROJECT_ID  -> projectId
 * If none are set the SDK falls back to a VERCEL_OIDC_TOKEN in the environment.
 *
 * Docs: https://vercel.com/docs/sandbox/sdk-reference
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
  SandboxStatus,
} from "@osr/core";
import { OsrError } from "@osr/core";
import { estimateCostFromModel } from "@osr/adapter-sim";
import { vercelManifest } from "./manifest.js";

/** Map OSR portable runtime names to Vercel runtimes. */
const RUNTIME_MAP: Record<string, string> = {
  "python-3.12": "python3.13",
  "node-20": "node22",
  "node-22": "node22",
  base: "node22",
};

function authFrom(creds: ProviderCreds): Record<string, string> {
  const auth: Record<string, string> = {};
  if (creds.token) auth.token = creds.token;
  if (creds.team_id) auth.teamId = creds.team_id;
  if (creds.project_id) auth.projectId = creds.project_id;
  return auth;
}

function mapStatus(status: string | undefined): SandboxStatus {
  switch (status) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "stopping":
    case "pending":
      return "provisioning";
    case "failed":
      return "error";
    default:
      return "running";
  }
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export class VercelSandboxAdapter implements SandboxAdapter {
  readonly id = "vercel";
  private modPromise?: Promise<any>;

  private async sdk(): Promise<any> {
    if (!this.modPromise) {
      const specifier = "@vercel/sandbox";
      this.modPromise = import(specifier);
    }
    return this.modPromise;
  }

  capabilities(): CapabilityManifest {
    return vercelManifest;
  }

  estimateCost(spec: NormalizedSpec): CostEstimate {
    return estimateCostFromModel(vercelManifest.costModel, spec);
  }

  async health(): Promise<HealthStatus> {
    return { provider: this.id, healthy: true, errorRate: 0, coldStartMsP50: vercelManifest.coldStartMsP50 };
  }

  private async connect(ref: string, creds: ProviderCreds): Promise<any> {
    const { Sandbox } = await this.sdk();
    return Sandbox.get({ name: ref, ...authFrom(creds) });
  }

  async create(spec: NormalizedSpec, creds: ProviderCreds): Promise<ProviderSandbox> {
    const { Sandbox } = await this.sdk();
    const runtime = RUNTIME_MAP[spec.template ?? "base"] ?? "node22";
    const ports = Array.isArray(spec.providerOptions?.["ports"])
      ? (spec.providerOptions!["ports"] as number[])
      : undefined;

    const sandbox = await Sandbox.create({
      runtime,
      resources: spec.resources.vcpu ? { vcpus: spec.resources.vcpu } : undefined,
      timeout: spec.ttlSeconds ? spec.ttlSeconds * 1000 : undefined,
      ports,
      env: spec.env,
      ...authFrom(creds),
    });

    return {
      providerRef: sandbox.name,
      status: mapStatus(sandbox.status),
      region: sandbox.region,
      expiresAt: sandbox.expiresAt ? new Date(sandbox.expiresAt).toISOString() : undefined,
      raw: { name: sandbox.name },
    };
  }

  async get(ref: string, creds: ProviderCreds): Promise<ProviderSandbox> {
    const sandbox = await this.connect(ref, creds);
    return { providerRef: ref, status: mapStatus(sandbox.status), region: sandbox.region };
  }

  async destroy(ref: string, creds: ProviderCreds): Promise<void> {
    const sandbox = await this.connect(ref, creds);
    await sandbox.stop();
  }

  async *exec(ref: string, req: ExecRequest, creds: ProviderCreds): AsyncIterable<ExecEvent> {
    const sandbox = await this.connect(ref, creds);
    const command = await sandbox.runCommand({
      cmd: req.cmd,
      args: req.args ?? [],
      cwd: req.cwd,
      env: req.env,
      detached: true,
    });
    for await (const log of command.logs()) {
      yield { type: log.stream === "stderr" ? "stderr" : "stdout", data: log.data };
    }
    const finished = await command.wait();
    yield { type: "exit", code: finished.exitCode ?? 0 };
  }

  fs: FsOps = {
    write: async (ref, path, data, creds) => {
      const sandbox = await this.connect(ref, creds);
      const dir = dirname(path);
      if (dir && dir !== "/") await sandbox.mkDir(dir).catch(() => {});
      await sandbox.writeFiles([{ path, content: Buffer.from(data) }]);
    },
    read: async (ref, path, creds) => {
      const sandbox = await this.connect(ref, creds);
      const buf = await sandbox.readFileToBuffer({ path });
      if (buf === null) throw new OsrError("NotFound", `${path} not found`, { provider: this.id });
      return new Uint8Array(buf);
    },
    list: async (ref, path, creds) => {
      const sandbox = await this.connect(ref, creds);
      const command = await sandbox.runCommand({ cmd: "ls", args: ["-1p", path] });
      const out: string = await command.stdout();
      return out
        .split("\n")
        .filter(Boolean)
        .map((name) => ({
          path: `${path.replace(/\/$/, "")}/${name.replace(/\/$/, "")}`,
          type: name.endsWith("/") ? ("dir" as const) : ("file" as const),
        }));
    },
    remove: async (ref, path, creds) => {
      const sandbox = await this.connect(ref, creds);
      await sandbox.runCommand({ cmd: "rm", args: ["-rf", path] });
    },
  };

  async exposePort(ref: string, port: number, creds: ProviderCreds): Promise<PortInfo> {
    const sandbox = await this.connect(ref, creds);
    // The port must have been declared in `ports` at create time (providerOptions.ports).
    return { port, url: sandbox.domain(port), protocol: "https" };
  }
}
