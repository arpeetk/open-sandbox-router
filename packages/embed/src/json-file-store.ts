import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long a lock can be held before we assume its owner crashed and steal it. */
const STALE_LOCK_MS = 5_000;
const LOCK_RETRY_MS = 20;
const LOCK_MAX_WAIT_MS = 2_000;

/** Synchronous sleep — Atomics.wait on a throwaway buffer, no busy-spin. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Generic JSON-file-backed store: read-entire-file / write-entire-file, with an advisory
 * mkdir-based lock around read-modify-write sequences. `mkdir` is atomic on every
 * filesystem Node runs on (it either creates the directory or fails with EEXIST — no
 * partial state), which makes "a lock is a directory" a dependency-free mutex: whoever's
 * `mkdirSync` succeeds holds the lock, everyone else retries until it's removed.
 *
 * Without this, two concurrent `osr` processes doing read -> mutate -> write against the
 * same file (e.g. two `osr create` calls for different tenants) can each read a stale
 * snapshot and the second write silently clobbers the first's already-persisted change —
 * this is the failure mode `readModifyWrite` exists to close.
 *
 * Single-user-machine, low-concurrency by design — this is a "never silently lose a
 * write" safety net, not a high-throughput distributed lock. If the lock can't be
 * acquired within LOCK_MAX_WAIT_MS (e.g. something is stuck holding it beyond even the
 * stale-lock grace period), we proceed unlocked rather than hang a CLI invocation
 * forever — a rare residual race is preferable to `osr` never returning.
 */
export class JsonFileStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly empty: () => T,
  ) {}

  read(): T {
    if (!existsSync(this.filePath)) return this.empty();
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as T;
    } catch {
      return this.empty();
    }
  }

  write(value: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(value, null, 2));
  }

  /** Atomically read, apply `fn`, and write back — the only way callers should mutate.
   * If `fn` throws, the lock is still released (via `finally`) and the write never
   * happens, matching the pre-lock behavior of a failed mutation. */
  readModifyWrite(fn: (current: T) => T): T {
    const lockPath = `${this.filePath}.lock`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.acquireLock(lockPath);
    try {
      const next = fn(this.read());
      this.write(next);
      return next;
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  private acquireLock(lockPath: string): void {
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lockPath); // atomic create; throws EEXIST if already locked
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        this.stealIfStale(lockPath);
        if (Date.now() > deadline) return; // give up waiting; proceed unlocked
        sleepSync(LOCK_RETRY_MS);
      }
    }
  }

  /** A lock left behind by a crashed process would otherwise deadlock every future
   * `osr` invocation forever — reclaim it once it's clearly abandoned. */
  private stealIfStale(lockPath: string): void {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Lock disappeared between the EEXIST and this check (the holder just finished) —
      // fine, the next loop iteration's mkdirSync will simply succeed.
    }
  }
}
