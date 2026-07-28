/**
 * Transport seam. The client's operations are defined once as `OsrOps` and implemented
 * two ways:
 *   - HttpOps: talks to a running gateway over REST + SSE (default).
 *   - LocalOps: drives an in-process SandboxService directly (CLI --local mode).
 *
 * Because SandboxHandle and OSR are written against OsrOps, their ergonomics are identical
 * regardless of which backend is in use.
 */

import type {
  CapabilityManifest,
  CodeEvent,
  CreateSandboxRequest,
  ExecEvent,
  FileEntry,
  PortInfo,
  ProviderRegistry,
  RoutePlan,
  Sandbox,
  SandboxService,
  SnapshotReference,
} from "@osr/core";
import { OsrError, type OsrErrorCode } from "@osr/core";

export interface CreateOutcome {
  sandbox: Sandbox;
  attempts: { provider: string; error?: string }[];
}

export type ProviderInfo = CapabilityManifest & { health?: unknown; simulated: boolean };

export interface ExecArgs {
  cmd: string;
  args?: string[];
  cwd?: string;
  timeoutSeconds?: number;
}

export interface CodeArgs {
  session: string;
  code: string;
  language?: string;
}

export interface OsrOps {
  providers(): Promise<ProviderInfo[]>;
  routePlan(req: CreateSandboxRequest): Promise<RoutePlan>;
  create(req: CreateSandboxRequest): Promise<CreateOutcome>;
  get(id: string): Promise<Sandbox>;
  list(): Promise<Sandbox[]>;
  destroy(id: string): Promise<void>;
  exec(id: string, req: ExecArgs): AsyncIterable<ExecEvent>;
  runCode(id: string, req: CodeArgs): AsyncIterable<CodeEvent>;
  fsWrite(id: string, path: string, content: string): Promise<void>;
  fsRead(id: string, path: string): Promise<string>;
  fsList(id: string, path: string): Promise<FileEntry[]>;
  exposePort(id: string, port: number): Promise<PortInfo>;
  pause(id: string): Promise<Sandbox>;
  resume(id: string): Promise<Sandbox>;
  snapshot(id: string): Promise<SnapshotReference>;
}

// ---- HTTP backend ---------------------------------------------------------

export interface HttpOpsOptions {
  baseUrl?: string;
  apiKey?: string;
  tenant?: string;
  fetch?: typeof fetch;
}

export class HttpOps implements OsrOps {
  private readonly baseUrl: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly doFetch: typeof fetch;

  constructor(opts: HttpOpsOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");
    this.baseHeaders = {};
    if (opts.apiKey) this.baseHeaders["authorization"] = `Bearer ${opts.apiKey}`;
    if (opts.tenant) this.baseHeaders["x-osr-tenant"] = opts.tenant;
    this.doFetch = opts.fetch ?? fetch;
  }

  private headers(hasBody: boolean): Record<string, string> {
    return hasBody ? { ...this.baseHeaders, "content-type": "application/json" } : { ...this.baseHeaders };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(this.baseUrl + path, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  private async *stream<T>(path: string, body: unknown): AsyncIterable<T> {
    const res = await this.doFetch(this.baseUrl + path, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw await toError(res);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const parsed = JSON.parse(dataLine.slice(5).trim());
        if (parsed?.error) {
          throw new OsrError((parsed.error.code as OsrErrorCode) ?? "Internal", parsed.error.message);
        }
        yield parsed as T;
      }
    }
  }

  providers(): Promise<ProviderInfo[]> {
    return this.request("GET", "/v1/providers");
  }
  routePlan(req: CreateSandboxRequest): Promise<RoutePlan> {
    return this.request("POST", "/v1/route/plan", req);
  }
  create(req: CreateSandboxRequest): Promise<CreateOutcome> {
    return this.request("POST", "/v1/sandboxes", req);
  }
  get(id: string): Promise<Sandbox> {
    return this.request("GET", `/v1/sandboxes/${id}`);
  }
  list(): Promise<Sandbox[]> {
    return this.request("GET", "/v1/sandboxes");
  }
  destroy(id: string): Promise<void> {
    return this.request("DELETE", `/v1/sandboxes/${id}`);
  }
  exec(id: string, req: ExecArgs): AsyncIterable<ExecEvent> {
    return this.stream<ExecEvent>(`/v1/sandboxes/${id}/exec`, req);
  }
  runCode(id: string, req: CodeArgs): AsyncIterable<CodeEvent> {
    return this.stream<CodeEvent>(`/v1/sandboxes/${id}/runCode`, req);
  }
  fsWrite(id: string, path: string, content: string): Promise<void> {
    return this.request("POST", `/v1/sandboxes/${id}/fs/write`, { path, content });
  }
  async fsRead(id: string, path: string): Promise<string> {
    const r = await this.request<{ content: string }>(
      "GET",
      `/v1/sandboxes/${id}/fs/read?path=${encodeURIComponent(path)}`,
    );
    return r.content;
  }
  fsList(id: string, path: string): Promise<FileEntry[]> {
    return this.request("GET", `/v1/sandboxes/${id}/fs/list?path=${encodeURIComponent(path)}`);
  }
  exposePort(id: string, port: number): Promise<PortInfo> {
    return this.request("POST", `/v1/sandboxes/${id}/ports`, { port });
  }
  pause(id: string): Promise<Sandbox> {
    return this.request("POST", `/v1/sandboxes/${id}/pause`, {});
  }
  resume(id: string): Promise<Sandbox> {
    return this.request("POST", `/v1/sandboxes/${id}/resume`, {});
  }
  snapshot(id: string): Promise<SnapshotReference> {
    return this.request("POST", `/v1/sandboxes/${id}/snapshot`, {});
  }
}

// ---- Local (in-process) backend ------------------------------------------

export interface LocalOpsOptions {
  service: SandboxService;
  registry: ProviderRegistry;
  tenant?: string;
}

export class LocalOps implements OsrOps {
  private readonly service: SandboxService;
  private readonly registry: ProviderRegistry;
  private readonly tenant: string;

  constructor(opts: LocalOpsOptions) {
    this.service = opts.service;
    this.registry = opts.registry;
    this.tenant = opts.tenant ?? "default";
  }

  async providers(): Promise<ProviderInfo[]> {
    return this.registry.manifests().map((m) => ({
      ...m,
      health: this.registry.healthOf(m.provider),
      simulated: this.registry.get(m.provider).simulated,
    }));
  }
  async routePlan(req: CreateSandboxRequest): Promise<RoutePlan> {
    return this.service.planRoute(req);
  }
  create(req: CreateSandboxRequest): Promise<CreateOutcome> {
    return this.service.create(req, { tenant: this.tenant });
  }
  get(id: string): Promise<Sandbox> {
    return this.service.get(id);
  }
  list(): Promise<Sandbox[]> {
    return this.service.list(this.tenant);
  }
  destroy(id: string): Promise<void> {
    return this.service.destroy(id);
  }
  exec(id: string, req: ExecArgs): AsyncIterable<ExecEvent> {
    return this.service.exec(id, req);
  }
  runCode(id: string, req: CodeArgs): AsyncIterable<CodeEvent> {
    return this.service.runCode(id, req);
  }
  fsWrite(id: string, path: string, content: string): Promise<void> {
    return this.service.fsWrite(id, path, new TextEncoder().encode(content));
  }
  async fsRead(id: string, path: string): Promise<string> {
    return new TextDecoder().decode(await this.service.fsRead(id, path));
  }
  fsList(id: string, path: string): Promise<FileEntry[]> {
    return this.service.fsList(id, path);
  }
  exposePort(id: string, port: number): Promise<PortInfo> {
    return this.service.exposePort(id, port);
  }
  pause(id: string): Promise<Sandbox> {
    return this.service.pause(id);
  }
  resume(id: string): Promise<Sandbox> {
    return this.service.resume(id);
  }
  snapshot(id: string): Promise<SnapshotReference> {
    return this.service.snapshot(id);
  }
}

async function toError(res: Response): Promise<OsrError> {
  let code: OsrErrorCode = "Internal";
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: OsrErrorCode; message?: string } };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    }
  } catch {
    // non-JSON error body
  }
  return new OsrError(code, message);
}
