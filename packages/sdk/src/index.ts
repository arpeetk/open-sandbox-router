/**
 * TypeScript client SDK for the Open Sandbox Router gateway.
 *
 * Provides an ergonomic Sandbox handle: create a sandbox, then run commands/code, read
 * and write files, and expose ports — without ever caring which provider served it.
 */

import type {
  CapabilityName,
  CodeEvent,
  CreateSandboxRequest,
  ExecEvent,
  FileEntry,
  PortInfo,
  Sandbox,
  CapabilityManifest,
} from "@osr/core";
import { OsrError, type OsrErrorCode } from "@osr/core";

export interface OsrClientOptions {
  baseUrl?: string;
  apiKey?: string;
  tenant?: string;
  fetch?: typeof fetch;
}

export interface CreateOutcome {
  sandbox: Sandbox;
  attempts: { provider: string; error?: string }[];
}

export class OSR {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;

  constructor(opts: OsrClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");
    this.headers = {};
    if (opts.apiKey) this.headers["authorization"] = `Bearer ${opts.apiKey}`;
    if (opts.tenant) this.headers["x-osr-tenant"] = opts.tenant;
    this.doFetch = opts.fetch ?? fetch;
  }

  /** Build request headers, setting content-type only when a JSON body is sent. */
  private headersFor(hasBody: boolean): Record<string, string> {
    return hasBody ? { ...this.headers, "content-type": "application/json" } : { ...this.headers };
  }

  readonly sandboxes = {
    create: async (req: CreateSandboxRequest): Promise<SandboxHandle> => {
      const outcome = await this.request<CreateOutcome>("POST", "/v1/sandboxes", req);
      return new SandboxHandle(this, outcome.sandbox, outcome.attempts);
    },
    get: async (id: string): Promise<SandboxHandle> => {
      const sandbox = await this.request<Sandbox>("GET", `/v1/sandboxes/${id}`);
      return new SandboxHandle(this, sandbox, []);
    },
    list: async (): Promise<Sandbox[]> => this.request<Sandbox[]>("GET", "/v1/sandboxes"),
  };

  providers(): Promise<(CapabilityManifest & { health: unknown })[]> {
    return this.request("GET", "/v1/providers");
  }

  routePlan(req: CreateSandboxRequest): Promise<unknown> {
    return this.request("POST", "/v1/route/plan", req);
  }

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(this.baseUrl + path, {
      method,
      headers: this.headersFor(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  /** @internal — stream an SSE endpoint as an async iterable of typed events. */
  async *stream<T>(path: string, body: unknown): AsyncIterable<T> {
    const res = await this.doFetch(this.baseUrl + path, {
      method: "POST",
      headers: this.headersFor(true),
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

  get baseUrlValue(): string {
    return this.baseUrl;
  }
}

export class SandboxHandle {
  constructor(
    private readonly client: OSR,
    public readonly sandbox: Sandbox,
    public readonly attempts: { provider: string; error?: string }[],
  ) {}

  get id(): string {
    return this.sandbox.id;
  }
  get provider(): string {
    return this.sandbox.provider;
  }
  get capabilities(): CapabilityName[] {
    return this.sandbox.capabilities;
  }

  exec(cmd: string, opts: { args?: string[]; cwd?: string; timeoutSeconds?: number } = {}): AsyncIterable<ExecEvent> {
    return this.client.stream<ExecEvent>(`/v1/sandboxes/${this.id}/exec`, { cmd, ...opts });
  }

  runCode(code: string, opts: { session?: string; language?: string } = {}): AsyncIterable<CodeEvent> {
    return this.client.stream<CodeEvent>(`/v1/sandboxes/${this.id}/runCode`, {
      session: opts.session ?? "default",
      code,
      language: opts.language,
    });
  }

  readonly fs = {
    write: (path: string, content: string): Promise<void> =>
      this.client.request("POST", `/v1/sandboxes/${this.id}/fs/write`, { path, content }),
    read: async (path: string): Promise<string> => {
      const r = await this.client.request<{ content: string }>(
        "GET",
        `/v1/sandboxes/${this.id}/fs/read?path=${encodeURIComponent(path)}`,
      );
      return r.content;
    },
    list: (path = "/"): Promise<FileEntry[]> =>
      this.client.request("GET", `/v1/sandboxes/${this.id}/fs/list?path=${encodeURIComponent(path)}`),
  };

  exposePort(port: number): Promise<PortInfo> {
    return this.client.request("POST", `/v1/sandboxes/${this.id}/ports`, { port });
  }

  destroy(): Promise<void> {
    return this.client.request("DELETE", `/v1/sandboxes/${this.id}`);
  }

  /** Convenience: run a command and collect stdout. */
  async run(cmd: string, args?: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    let stdout = "";
    let stderr = "";
    let code = 0;
    for await (const ev of this.exec(cmd, args ? { args } : {})) {
      if (ev.type === "stdout") stdout += ev.data;
      else if (ev.type === "stderr") stderr += ev.data;
      else code = ev.code;
    }
    return { stdout, stderr, code };
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
