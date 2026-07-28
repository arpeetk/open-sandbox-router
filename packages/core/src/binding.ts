/**
 * Sandbox -> provider binding store. Because a sandbox is stateful and pinned to its
 * home provider for life, every non-create operation resolves the binding and
 * dispatches to the same provider. This is the durable heart of session affinity.
 *
 * The in-memory implementation here is for tests, the library mode, and the demo.
 * The gateway ships a Postgres-backed implementation of the same interface.
 */

import type { CapabilityName, ResourceSpec, SandboxStatus } from "./types.js";

export interface Binding {
  sandboxId: string;
  provider: string;
  /** True if `provider` was a simulated stand-in at create time (see
   * SandboxAdapter.simulated). Recorded once, at creation — not re-checked later. */
  simulated: boolean;
  providerRef: string;
  tenant: string;
  region?: string;
  template?: string;
  resources: ResourceSpec;
  capabilities: CapabilityName[];
  status: SandboxStatus;
  metadata: Record<string, string>;
  createdAt: string;
  lastActiveAt: string;
  expiresAt?: string;
  /** Idempotency key that produced this binding, if any. */
  idempotencyKey?: string;
  /** Caller-chosen stable name for get-or-create reuse, if any. */
  name?: string;
}

export interface BindingStore {
  create(binding: Binding): Promise<void>;
  get(sandboxId: string): Promise<Binding | undefined>;
  findByIdempotencyKey(tenant: string, key: string): Promise<Binding | undefined>;
  /** Look up a live binding for named get-or-create reuse. */
  findByName(tenant: string, name: string): Promise<Binding | undefined>;
  update(sandboxId: string, patch: Partial<Binding>): Promise<Binding>;
  delete(sandboxId: string): Promise<void>;
  list(tenant: string): Promise<Binding[]>;
  /** Bindings whose TTL has elapsed, for the reaper. */
  expired(now?: Date): Promise<Binding[]>;
}

export class InMemoryBindingStore implements BindingStore {
  private readonly byId = new Map<string, Binding>();

  async create(binding: Binding): Promise<void> {
    this.byId.set(binding.sandboxId, { ...binding });
  }

  async get(sandboxId: string): Promise<Binding | undefined> {
    const b = this.byId.get(sandboxId);
    return b ? { ...b } : undefined;
  }

  async findByIdempotencyKey(tenant: string, key: string): Promise<Binding | undefined> {
    for (const b of this.byId.values()) {
      if (b.tenant === tenant && b.idempotencyKey === key) return { ...b };
    }
    return undefined;
  }

  async findByName(tenant: string, name: string): Promise<Binding | undefined> {
    for (const b of this.byId.values()) {
      if (b.tenant === tenant && b.name === name) return { ...b };
    }
    return undefined;
  }

  async update(sandboxId: string, patch: Partial<Binding>): Promise<Binding> {
    const cur = this.byId.get(sandboxId);
    if (!cur) throw new Error(`binding ${sandboxId} not found`);
    const next = { ...cur, ...patch, lastActiveAt: new Date().toISOString() };
    this.byId.set(sandboxId, next);
    return { ...next };
  }

  async delete(sandboxId: string): Promise<void> {
    this.byId.delete(sandboxId);
  }

  async list(tenant: string): Promise<Binding[]> {
    return [...this.byId.values()].filter((b) => b.tenant === tenant).map((b) => ({ ...b }));
  }

  async expired(now = new Date()): Promise<Binding[]> {
    const t = now.getTime();
    return [...this.byId.values()]
      .filter((b) => b.expiresAt && Date.parse(b.expiresAt) < t)
      .map((b) => ({ ...b }));
  }
}
