import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persistent CLI preferences — the difference between typing `--local` (or `--url`,
 * `--tenant`) on every single invocation and setting it once. Mirrors
 * FileBindingStore's read/write-whole-file pattern (single-user, low-concurrency by
 * design: each op reads, mutates, and rewrites the file).
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

export class FileCliConfig {
  constructor(private readonly filePath: string) {}

  read(): CliConfig {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as CliConfig;
    } catch {
      return {};
    }
  }

  write(config: CliConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(config, null, 2));
  }

  /** Merge a partial update into the existing config (top-level keys only). */
  update(patch: Partial<CliConfig>): CliConfig {
    const next = { ...this.read(), ...patch };
    this.write(next);
    return next;
  }

  unset(key: keyof CliConfig): CliConfig {
    const cur = this.read();
    delete cur[key];
    // Clearing `mode` should also clear how it was decided, so a fresh probe can run.
    if (key === "mode") delete cur.modeSource;
    this.write(cur);
    return cur;
  }

  setCurrentSandbox(tenant: string, sandboxId: string): CliConfig {
    const cur = this.read();
    cur.current = { ...cur.current, [tenant]: sandboxId };
    this.write(cur);
    return cur;
  }

  currentSandbox(tenant: string): string | undefined {
    return this.read().current?.[tenant];
  }
}
