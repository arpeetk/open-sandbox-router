import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Binding, BindingStore } from "@osr/core";

/**
 * A JSON-file-backed binding store for local mode. Because the CLI runs as a fresh
 * process per command, the sandbox->provider binding must survive between invocations —
 * this persists it to disk so `osr create` in one shell and `osr exec` in another
 * dispatch to the same provider.
 *
 * Single-user, low-concurrency by design: each op reads, mutates, and rewrites the file.
 */
export class FileBindingStore implements BindingStore {
  constructor(private readonly filePath: string) {}

  private read(): Record<string, Binding> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, Binding>;
    } catch {
      return {};
    }
  }

  private write(map: Record<string, Binding>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(map, null, 2));
  }

  async create(binding: Binding): Promise<void> {
    const map = this.read();
    map[binding.sandboxId] = binding;
    this.write(map);
  }

  async get(sandboxId: string): Promise<Binding | undefined> {
    return this.read()[sandboxId];
  }

  async findByIdempotencyKey(tenant: string, key: string): Promise<Binding | undefined> {
    return Object.values(this.read()).find((b) => b.tenant === tenant && b.idempotencyKey === key);
  }

  async findByName(tenant: string, name: string): Promise<Binding | undefined> {
    return Object.values(this.read()).find((b) => b.tenant === tenant && b.name === name);
  }

  async update(sandboxId: string, patch: Partial<Binding>): Promise<Binding> {
    const map = this.read();
    const cur = map[sandboxId];
    if (!cur) throw new Error(`binding ${sandboxId} not found`);
    const next = { ...cur, ...patch, lastActiveAt: new Date().toISOString() };
    map[sandboxId] = next;
    this.write(map);
    return next;
  }

  async delete(sandboxId: string): Promise<void> {
    const map = this.read();
    delete map[sandboxId];
    this.write(map);
  }

  async list(tenant: string): Promise<Binding[]> {
    return Object.values(this.read()).filter((b) => b.tenant === tenant);
  }

  async expired(now = new Date()): Promise<Binding[]> {
    const t = now.getTime();
    return Object.values(this.read()).filter((b) => b.expiresAt && Date.parse(b.expiresAt) < t);
  }
}
