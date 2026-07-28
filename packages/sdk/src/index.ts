/**
 * TypeScript client SDK for Open Sandbox Router.
 *
 * Provides an ergonomic Sandbox handle: create a sandbox, then run commands/code, read
 * and write files, and expose ports — without caring which provider served it, or whether
 * you're talking to a gateway (HttpOps) or an in-process service (LocalOps).
 */

import type {
  CapabilityName,
  CodeEvent,
  CreateSandboxRequest,
  ExecEvent,
  FileEntry,
  PortInfo,
  RoutePlan,
  Sandbox,
} from "@osr/core";
import {
  HttpOps,
  type CreateOutcome,
  type OsrOps,
  type ProviderInfo,
} from "./ops.js";

export {
  HttpOps,
  LocalOps,
  type OsrOps,
  type CreateOutcome,
  type ProviderInfo,
  type LocalOpsOptions,
  type HttpOpsOptions,
} from "./ops.js";

export interface OsrClientOptions {
  baseUrl?: string;
  apiKey?: string;
  tenant?: string;
  fetch?: typeof fetch;
  /** Provide a custom backend (e.g. LocalOps) instead of the default HTTP transport. */
  ops?: OsrOps;
}

export class OSR {
  /** The active backend (HttpOps by default, or a supplied one such as LocalOps). */
  readonly ops: OsrOps;

  constructor(opts: OsrClientOptions = {}) {
    this.ops =
      opts.ops ??
      new HttpOps({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, tenant: opts.tenant, fetch: opts.fetch });
  }

  readonly sandboxes = {
    create: async (req: CreateSandboxRequest): Promise<SandboxHandle> => {
      const outcome = await this.ops.create(req);
      return new SandboxHandle(this.ops, outcome.sandbox, outcome.attempts);
    },
    get: async (id: string): Promise<SandboxHandle> => {
      return new SandboxHandle(this.ops, await this.ops.get(id), []);
    },
    list: (): Promise<Sandbox[]> => this.ops.list(),
  };

  providers(): Promise<ProviderInfo[]> {
    return this.ops.providers();
  }

  routePlan(req: CreateSandboxRequest): Promise<RoutePlan> {
    return this.ops.routePlan(req);
  }
}

export class SandboxHandle {
  constructor(
    private readonly ops: OsrOps,
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

  exec(
    cmd: string,
    opts: { args?: string[]; cwd?: string; timeoutSeconds?: number } = {},
  ): AsyncIterable<ExecEvent> {
    return this.ops.exec(this.id, { cmd, ...opts });
  }

  runCode(code: string, opts: { session?: string; language?: string } = {}): AsyncIterable<CodeEvent> {
    return this.ops.runCode(this.id, { session: opts.session ?? "default", code, language: opts.language });
  }

  readonly fs = {
    write: (path: string, content: string): Promise<void> => this.ops.fsWrite(this.id, path, content),
    read: (path: string): Promise<string> => this.ops.fsRead(this.id, path),
    list: (path = "/"): Promise<FileEntry[]> => this.ops.fsList(this.id, path),
  };

  exposePort(port: number): Promise<PortInfo> {
    return this.ops.exposePort(this.id, port);
  }

  destroy(): Promise<void> {
    return this.ops.destroy(this.id);
  }

  /** Convenience: run a command and collect stdout/stderr/exit. */
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
