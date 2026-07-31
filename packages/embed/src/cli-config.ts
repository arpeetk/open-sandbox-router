import { JsonFileStore } from "./json-file-store.js";

/**
 * Persistent CLI preferences — the difference between typing `--local` (or `--url`,
 * `--tenant`) on every single invocation and setting it once.
 */
export interface CliConfig {
  mode?: "local" | "gateway";
  /** How `mode` was decided — lets `osr doctor`/`config get` explain a guess vs. a
   * deliberate choice, and tells `config unset mode` whether re-probing makes sense. */
  modeSource?: "explicit" | "auto";
  url?: string;
  tenant?: string;
  /** Current sandbox id per tenant, set via `osr use <id>` (see §Phase 2). */
  current?: Record<string, string>;
}

/**
 * Mutations go through `JsonFileStore#readModifyWrite`, which holds an advisory file
 * lock across the read-mutate-write sequence so two concurrent `osr` processes (e.g.
 * `osr use` in one shell racing `osr create` in another) can't silently clobber each
 * other's writes.
 */
export class FileCliConfig {
  private readonly store: JsonFileStore<CliConfig>;

  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, () => ({}));
  }

  read(): CliConfig {
    return this.store.read();
  }

  write(config: CliConfig): void {
    this.store.write(config);
  }

  /** Merge a partial update into the existing config (top-level keys only). */
  update(patch: Partial<CliConfig>): CliConfig {
    return this.store.readModifyWrite((cur) => ({ ...cur, ...patch }));
  }

  unset(key: keyof CliConfig): CliConfig {
    return this.store.readModifyWrite((cur) => {
      const next = { ...cur };
      delete next[key];
      // Clearing `mode` should also clear how it was decided, so a fresh probe can run.
      if (key === "mode") delete next.modeSource;
      return next;
    });
  }

  setCurrentSandbox(tenant: string, sandboxId: string): CliConfig {
    return this.store.readModifyWrite((cur) => ({
      ...cur,
      current: { ...cur.current, [tenant]: sandboxId },
    }));
  }

  currentSandbox(tenant: string): string | undefined {
    return this.store.read().current?.[tenant];
  }

  /** Clear only this tenant's current sandbox — never the whole `current` map, which
   * would wipe other tenants' state too. */
  clearCurrentSandbox(tenant: string): void {
    this.store.readModifyWrite((cur) => {
      if (!cur.current) return cur;
      const current = { ...cur.current };
      delete current[tenant];
      return { ...cur, current };
    });
  }
}
