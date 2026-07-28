/**
 * A minimal boundary over the Kubernetes API for the operations a sandbox needs. Two
 * implementations:
 *
 *  - ClientNodeKubeApi: real, backed by `@kubernetes/client-node`. Sandboxes are Pods;
 *    exec/fs use the Pod exec subresource. Loaded via a dynamic import so the dependency
 *    is optional and only required when the K8s adapter is actually used.
 *  - SimulatedKubeApi: in-memory, so the adapter can run in tests/demo without a cluster.
 *
 * Keeping this behind an interface means the adapter's normalized-op mapping is readable
 * and testable independent of the (heavy) client library.
 */

import type { FileEntry } from "@osr/core";
import { SimulatedRuntime } from "@osr/adapter-sim";

export interface PodSpec {
  name: string;
  image: string;
  namespace: string;
  vcpu: number;
  memoryMB: number;
  gpu?: number | string;
  labels: Record<string, string>;
  ttlSeconds?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface KubeApi {
  createPod(spec: PodSpec): Promise<string>;
  getPodPhase(namespace: string, name: string): Promise<string>;
  deletePod(namespace: string, name: string): Promise<void>;
  exec(namespace: string, name: string, argv: string[], stdin?: string): Promise<ExecResult>;
  writeFile(namespace: string, name: string, path: string, data: Uint8Array): Promise<void>;
  readFile(namespace: string, name: string, path: string): Promise<Uint8Array>;
  listFiles(namespace: string, name: string, path: string): Promise<FileEntry[]>;
}

/** Build the Pod manifest OSR uses for a sandbox. Shared by real + doc paths. */
export function podManifest(spec: PodSpec): Record<string, unknown> {
  const resources: Record<string, unknown> = {
    requests: { cpu: String(spec.vcpu), memory: `${spec.memoryMB}Mi` },
    limits: { cpu: String(spec.vcpu), memory: `${spec.memoryMB}Mi` },
  };
  if (spec.gpu) {
    (resources.limits as Record<string, unknown>)["nvidia.com/gpu"] = String(spec.gpu);
  }
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: { "app.kubernetes.io/managed-by": "osr", ...spec.labels },
      annotations: spec.ttlSeconds ? { "osr.dev/ttl-seconds": String(spec.ttlSeconds) } : {},
    },
    spec: {
      restartPolicy: "Never",
      // A gVisor RuntimeClass (or Kata/Firecracker) provides the isolation boundary for
      // untrusted code. Operators set this to match their cluster.
      runtimeClassName: "gvisor",
      automountServiceAccountToken: false,
      containers: [
        {
          name: "sandbox",
          image: spec.image,
          command: ["sleep", "infinity"],
          resources,
          securityContext: {
            runAsNonRoot: true,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

/** Real implementation using @kubernetes/client-node (loaded lazily). */
export class ClientNodeKubeApi implements KubeApi {
  private core: any;
  private execClient: any;
  private kc: any;

  private async ensure(): Promise<void> {
    if (this.core) return;
    // Non-literal specifier keeps this an optional dependency (no type resolution needed).
    const specifier = "@kubernetes/client-node";
    const k8s: any = await import(specifier);
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.execClient = new k8s.Exec(this.kc);
  }

  async createPod(spec: PodSpec): Promise<string> {
    await this.ensure();
    await this.core.createNamespacedPod({ namespace: spec.namespace, body: podManifest(spec) });
    return spec.name;
  }

  async getPodPhase(namespace: string, name: string): Promise<string> {
    await this.ensure();
    const res = await this.core.readNamespacedPodStatus({ namespace, name });
    return res?.status?.phase ?? "Unknown";
  }

  async deletePod(namespace: string, name: string): Promise<void> {
    await this.ensure();
    await this.core.deleteNamespacedPod({ namespace, name });
  }

  async exec(namespace: string, name: string, argv: string[], stdin?: string): Promise<ExecResult> {
    await this.ensure();
    const { Writable, Readable } = await import("node:stream");
    let stdout = "";
    let stderr = "";
    const outStream = new Writable({ write(c, _e, cb) { stdout += c.toString(); cb(); } });
    const errStream = new Writable({ write(c, _e, cb) { stderr += c.toString(); cb(); } });
    const inStream = stdin !== undefined ? Readable.from([stdin]) : null;

    const exitCode: number = await new Promise((resolve, reject) => {
      this.execClient
        .exec(
          namespace,
          name,
          "sandbox",
          argv,
          outStream,
          errStream,
          inStream,
          false,
          (status: any) => resolve(status?.status === "Success" ? 0 : 1),
        )
        .catch(reject);
    });
    return { stdout, stderr, exitCode };
  }

  async writeFile(namespace: string, name: string, path: string, data: Uint8Array): Promise<void> {
    const content = Buffer.from(data).toString("utf8");
    const res = await this.exec(namespace, name, ["sh", "-c", `cat > "${path}"`], content);
    if (res.exitCode !== 0) throw new Error(`write ${path} failed: ${res.stderr}`);
  }

  async readFile(namespace: string, name: string, path: string): Promise<Uint8Array> {
    const res = await this.exec(namespace, name, ["cat", path]);
    if (res.exitCode !== 0) throw new Error(`read ${path} failed: ${res.stderr}`);
    return new TextEncoder().encode(res.stdout);
  }

  async listFiles(namespace: string, name: string, path: string): Promise<FileEntry[]> {
    const res = await this.exec(namespace, name, ["ls", "-1", path]);
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((p) => ({ path: `${path.replace(/\/$/, "")}/${p}`, type: "file" as const }));
  }
}

/** In-memory implementation so the adapter is runnable without a cluster. */
export class SimulatedKubeApi implements KubeApi {
  private readonly runtime = new SimulatedRuntime("kubernetes");
  private readonly pods = new Map<string, string>(); // key -> ref

  private key(ns: string, name: string): string {
    return `${ns}/${name}`;
  }

  async createPod(spec: PodSpec): Promise<string> {
    const ref = this.runtime.create();
    this.pods.set(this.key(spec.namespace, spec.name), ref);
    return spec.name;
  }

  async getPodPhase(ns: string, name: string): Promise<string> {
    return this.pods.has(this.key(ns, name)) ? "Running" : "NotFound";
  }

  async deletePod(ns: string, name: string): Promise<void> {
    const k = this.key(ns, name);
    const ref = this.pods.get(k);
    if (ref) this.runtime.destroy(ref);
    this.pods.delete(k);
  }

  private ref(ns: string, name: string): string {
    const ref = this.pods.get(this.key(ns, name));
    if (!ref) throw new Error(`pod ${ns}/${name} not found`);
    return ref;
  }

  async exec(ns: string, name: string, argv: string[]): Promise<ExecResult> {
    const ref = this.ref(ns, name);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for await (const e of this.runtime.exec(ref, { cmd: argv[0] ?? "", args: argv.slice(1) })) {
      if (e.type === "stdout") stdout += e.data;
      else if (e.type === "stderr") stderr += e.data;
      else exitCode = e.code;
    }
    return { stdout, stderr, exitCode };
  }

  async writeFile(ns: string, name: string, path: string, data: Uint8Array): Promise<void> {
    this.runtime.writeFile(this.ref(ns, name), path, data);
  }

  async readFile(ns: string, name: string, path: string): Promise<Uint8Array> {
    return this.runtime.readFile(this.ref(ns, name), path);
  }

  async listFiles(ns: string, name: string, path: string): Promise<FileEntry[]> {
    return this.runtime.listFiles(this.ref(ns, name), path);
  }
}
