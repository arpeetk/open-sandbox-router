/**
 * SandboxService orchestrates the two regimes that define OSR:
 *
 *  1. create() — the ONLY place routing happens. It negotiates capabilities, scores
 *     providers, then attempts them in order with create-time failover, and on success
 *     writes a durable sandbox->provider binding.
 *  2. every other op — resolves the binding and dispatches to the sandbox's home
 *     provider (session affinity). There is no re-routing of an existing sandbox.
 */

import type { NormalizedSpec, ProviderCreds, SandboxAdapter } from "./adapter.js";
import type { Binding, BindingStore } from "./binding.js";
import { grantedCapabilities } from "./capabilities.js";
import { FAILOVER_CODES, OsrError, isOsrError } from "./errors.js";
import type { ProviderRegistry } from "./registry.js";
import { Router, type RoutePlan } from "./router.js";
import type {
  CodeEvent,
  CodeRequest,
  CreateSandboxRequest,
  ExecEvent,
  ExecRequest,
  FileEntry,
  PortInfo,
  ProviderSandbox,
  Sandbox,
} from "./types.js";

/** Resolves scoped provider credentials for a given tenant + provider (BYOK). */
export interface CredentialProvider {
  credentialsFor(tenant: string, provider: string): Promise<ProviderCreds>;
}

/** Sink for normalized usage/metering records. */
export interface Meter {
  record(event: {
    sandboxId: string;
    tenant: string;
    provider: string;
    op: string;
    durationMs: number;
    estUsdPerHour?: number;
    ok: boolean;
  }): void;
}

export interface RequestContext {
  tenant: string;
}

export interface ServiceOptions {
  registry: ProviderRegistry;
  bindings: BindingStore;
  credentials: CredentialProvider;
  meter?: Meter;
  idGenerator?: () => string;
}

export interface CreateOutcome {
  sandbox: Sandbox;
  /** Providers attempted before success, with failure reasons (for observability). */
  attempts: { provider: string; error?: string }[];
}

export class SandboxService {
  private readonly registry: ProviderRegistry;
  private readonly bindings: BindingStore;
  private readonly credentials: CredentialProvider;
  private readonly router: Router;
  private readonly meter?: Meter;
  private readonly newId: () => string;

  constructor(opts: ServiceOptions) {
    this.registry = opts.registry;
    this.bindings = opts.bindings;
    this.credentials = opts.credentials;
    this.meter = opts.meter;
    this.router = new Router(opts.registry);
    this.newId = opts.idGenerator ?? defaultIdGenerator;
  }

  // ---- routing --------------------------------------------------------------

  /** Dry-run the router for a create request without provisioning anything. */
  planRoute(req: CreateSandboxRequest): RoutePlan {
    const spec: NormalizedSpec = {
      template: req.template,
      resources: req.resources ?? {},
      ttlSeconds: req.ttlSeconds,
      env: req.env,
      region: req.routing?.region,
    };
    return this.router.plan(
      {
        requiredCapabilities: req.requiredCapabilities ?? [],
        preferredCapabilities: req.preferredCapabilities,
        resources: req.resources,
        template: req.template,
        ttlSeconds: req.ttlSeconds,
        routing: req.routing,
      },
      spec,
    );
  }

  // ---- create (routing + failover + bind) ---------------------------------

  async create(req: CreateSandboxRequest, ctx: RequestContext): Promise<CreateOutcome> {
    if (req.idempotencyKey) {
      const existing = await this.bindings.findByIdempotencyKey(ctx.tenant, req.idempotencyKey);
      if (existing) return { sandbox: toSandbox(existing), attempts: [] };
    }

    const spec: NormalizedSpec = {
      template: req.template,
      resources: req.resources ?? {},
      ttlSeconds: req.ttlSeconds,
      env: req.env,
      region: req.routing?.region,
      providerOptions: undefined,
    };

    const plan = this.router.plan(
      {
        requiredCapabilities: req.requiredCapabilities ?? [],
        preferredCapabilities: req.preferredCapabilities,
        resources: req.resources,
        template: req.template,
        ttlSeconds: req.ttlSeconds,
        routing: req.routing,
      },
      spec,
    );

    const allowFallbacks = req.routing?.allowFallbacks ?? true;
    const attempts: { provider: string; error?: string }[] = [];

    for (const candidate of plan.candidates) {
      const adapter = this.registry.get(candidate.provider);
      const creds = await this.credentials.credentialsFor(ctx.tenant, candidate.provider);
      const providerSpec: NormalizedSpec = {
        ...spec,
        providerOptions: req.providerOptions?.[candidate.provider],
      };
      const started = Date.now();
      try {
        const ps = await adapter.create(providerSpec, creds);
        this.registry.recordOutcome(candidate.provider, true);
        this.meter?.record({
          sandboxId: ps.providerRef,
          tenant: ctx.tenant,
          provider: candidate.provider,
          op: "create",
          durationMs: Date.now() - started,
          estUsdPerHour: candidate.estimatedUsdPerHour,
          ok: true,
        });

        const binding = this.bindingFrom(req, ctx, adapter, candidate.provider, ps);
        await this.bindings.create(binding);
        attempts.push({ provider: candidate.provider });
        return { sandbox: toSandbox(binding), attempts };
      } catch (err) {
        const code = isOsrError(err) ? err.code : "Internal";
        this.registry.recordOutcome(candidate.provider, false);
        attempts.push({ provider: candidate.provider, error: `${code}: ${(err as Error).message}` });
        this.meter?.record({
          sandboxId: "-",
          tenant: ctx.tenant,
          provider: candidate.provider,
          op: "create",
          durationMs: Date.now() - started,
          ok: false,
        });

        const canFailover = allowFallbacks && isOsrError(err) && FAILOVER_CODES.has(err.code);
        if (!canFailover) throw err;
        // otherwise try the next candidate
      }
    }

    throw new OsrError("AllProvidersFailed", "every candidate provider failed", {
      details: { attempts },
    });
  }

  // ---- dispatch helpers ----------------------------------------------------

  private async resolve(sandboxId: string): Promise<{
    binding: Binding;
    adapter: SandboxAdapter;
    creds: ProviderCreds;
  }> {
    const binding = await this.bindings.get(sandboxId);
    if (!binding) throw new OsrError("NotFound", `sandbox "${sandboxId}" not found`);
    const adapter = this.registry.get(binding.provider);
    const creds = await this.credentials.credentialsFor(binding.tenant, binding.provider);
    return { binding, adapter, creds };
  }

  async get(sandboxId: string): Promise<Sandbox> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    const ps = await adapter.get(binding.providerRef, creds);
    const updated = await this.bindings.update(sandboxId, {
      status: ps.status,
      expiresAt: ps.expiresAt ?? binding.expiresAt,
    });
    return toSandbox(updated);
  }

  async list(tenant: string): Promise<Sandbox[]> {
    return (await this.bindings.list(tenant)).map(toSandbox);
  }

  async destroy(sandboxId: string): Promise<void> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    await adapter.destroy(binding.providerRef, creds);
    await this.bindings.delete(sandboxId);
  }

  async *exec(sandboxId: string, req: ExecRequest): AsyncIterable<ExecEvent> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    yield* adapter.exec(binding.providerRef, req, creds);
    await this.bindings.update(sandboxId, {});
  }

  async *runCode(sandboxId: string, req: CodeRequest): AsyncIterable<CodeEvent> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    if (!adapter.runCode) {
      throw new OsrError("CapabilityUnsupported", `provider "${binding.provider}" has no runCode`, {
        provider: binding.provider,
      });
    }
    yield* adapter.runCode(binding.providerRef, req, creds);
  }

  async fsRead(sandboxId: string, path: string): Promise<Uint8Array> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    return adapter.fs.read(binding.providerRef, path, creds);
  }

  async fsWrite(sandboxId: string, path: string, data: Uint8Array): Promise<void> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    await adapter.fs.write(binding.providerRef, path, data, creds);
  }

  async fsList(sandboxId: string, path: string): Promise<FileEntry[]> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    return adapter.fs.list(binding.providerRef, path, creds);
  }

  async exposePort(sandboxId: string, port: number): Promise<PortInfo> {
    const { binding, adapter, creds } = await this.resolve(sandboxId);
    if (!adapter.exposePort) {
      throw new OsrError("CapabilityUnsupported", `provider "${binding.provider}" cannot expose ports`, {
        provider: binding.provider,
      });
    }
    const info = await adapter.exposePort(binding.providerRef, port, creds);
    await this.bindings.update(sandboxId, {});
    return info;
  }

  // ---- internal ------------------------------------------------------------

  private bindingFrom(
    req: CreateSandboxRequest,
    ctx: RequestContext,
    adapter: SandboxAdapter,
    provider: string,
    ps: ProviderSandbox,
  ): Binding {
    const now = new Date().toISOString();
    return {
      sandboxId: this.newId(),
      provider,
      providerRef: ps.providerRef,
      tenant: ctx.tenant,
      region: ps.region ?? req.routing?.region,
      template: req.template,
      resources: req.resources ?? {},
      capabilities: grantedCapabilities(adapter.capabilities()),
      status: ps.status,
      metadata: req.metadata ?? {},
      createdAt: now,
      lastActiveAt: now,
      expiresAt: ps.expiresAt,
      idempotencyKey: req.idempotencyKey,
    };
  }
}

function toSandbox(b: Binding): Sandbox {
  return {
    id: b.sandboxId,
    provider: b.provider,
    status: b.status,
    template: b.template,
    resources: b.resources,
    region: b.region,
    capabilities: b.capabilities,
    ports: [],
    metadata: b.metadata,
    createdAt: b.createdAt,
    lastActiveAt: b.lastActiveAt,
    expiresAt: b.expiresAt,
  };
}

function defaultIdGenerator(): string {
  return "sbx_" + Math.random().toString(36).slice(2, 12);
}
