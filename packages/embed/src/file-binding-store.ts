import type { Binding, BindingStore } from "@osr/core";
import { JsonFileStore } from "./json-file-store.js";

/**
 * A JSON-file-backed binding store for local mode. Because the CLI runs as a fresh
 * process per command, the sandbox->provider binding must survive between invocations —
 * this persists it to disk so `osr create` in one shell and `osr exec` in another
 * dispatch to the same provider.
 *
 * Mutations go through `JsonFileStore#readModifyWrite`, which holds an advisory file
 * lock across the read-mutate-write sequence so two concurrent `osr` processes can't
 * silently clobber each other's writes.
 */
export class FileBindingStore implements BindingStore {
  private readonly store: JsonFileStore<Record<string, Binding>>;

  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, () => ({}));
  }

  async create(binding: Binding): Promise<void> {
    this.store.readModifyWrite((map) => ({ ...map, [binding.sandboxId]: binding }));
  }

  async get(sandboxId: string): Promise<Binding | undefined> {
    return this.store.read()[sandboxId];
  }

  async findByIdempotencyKey(tenant: string, key: string): Promise<Binding | undefined> {
    return Object.values(this.store.read()).find((b) => b.tenant === tenant && b.idempotencyKey === key);
  }

  async findByName(tenant: string, name: string): Promise<Binding | undefined> {
    return Object.values(this.store.read()).find((b) => b.tenant === tenant && b.name === name);
  }

  async update(sandboxId: string, patch: Partial<Binding>): Promise<Binding> {
    let updated: Binding | undefined;
    this.store.readModifyWrite((map) => {
      const cur = map[sandboxId];
      if (!cur) throw new Error(`binding ${sandboxId} not found`);
      updated = { ...cur, ...patch, lastActiveAt: new Date().toISOString() };
      return { ...map, [sandboxId]: updated };
    });
    return updated!;
  }

  async delete(sandboxId: string): Promise<void> {
    this.store.readModifyWrite((map) => {
      const next = { ...map };
      delete next[sandboxId];
      return next;
    });
  }

  async list(tenant: string): Promise<Binding[]> {
    return Object.values(this.store.read()).filter((b) => b.tenant === tenant);
  }

  async expired(now = new Date()): Promise<Binding[]> {
    const t = now.getTime();
    return Object.values(this.store.read()).filter((b) => b.expiresAt && Date.parse(b.expiresAt) < t);
  }
}
