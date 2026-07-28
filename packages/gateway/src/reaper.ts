import type { SandboxService } from "@osr/core";

/**
 * Periodically destroys sandboxes whose TTL has elapsed. `ttlSeconds` at create time is
 * otherwise just stored data — nothing enforces it without a reaper actually running.
 *
 * Deliberately NOT started by `buildContext()`/`buildServer()` (used by tests and library
 * mode) — only `main.ts` calls this, so test runs never leak a background timer.
 */
export function startReaper(service: SandboxService, intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    service.reapExpired().then(({ destroyed, failed }) => {
      if (destroyed.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[osr] reaper destroyed ${destroyed.length} expired sandbox(es): ${destroyed.join(", ")}`);
      }
      for (const f of failed) {
        // eslint-disable-next-line no-console
        console.error(`[osr] reaper failed to destroy ${f.sandboxId}: ${f.error}`);
      }
    }, (err) => {
      // eslint-disable-next-line no-console
      console.error("[osr] reaper sweep failed:", err);
    });
  }, intervalMs);
}
