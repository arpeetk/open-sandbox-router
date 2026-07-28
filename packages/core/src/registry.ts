/**
 * Provider registry + health monitor. Holds the set of registered adapters and a
 * rolling view of each provider's health, which the router consults for outage
 * avoidance and reliability scoring.
 */

import type { SandboxAdapter } from "./adapter.js";
import type { CapabilityManifest } from "./capabilities.js";
import type { HealthStatus } from "./types.js";
import { OsrError } from "./errors.js";

/** Window after an observed outage during which a provider is deprioritized. */
export const OUTAGE_DEPRIORITIZE_MS = 30_000;

export class ProviderRegistry {
  private readonly adapters = new Map<string, SandboxAdapter>();
  private readonly health = new Map<string, HealthStatus>();

  register(adapter: SandboxAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.health.set(adapter.id, {
      provider: adapter.id,
      healthy: true,
      errorRate: 0,
      coldStartMsP50: adapter.capabilities().coldStartMsP50,
    });
  }

  get(id: string): SandboxAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new OsrError("NotFound", `no adapter registered for provider "${id}"`);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): SandboxAdapter[] {
    return [...this.adapters.values()];
  }

  manifests(): CapabilityManifest[] {
    return this.list().map((a) => a.capabilities());
  }

  healthOf(id: string): HealthStatus {
    return (
      this.health.get(id) ?? { provider: id, healthy: true, errorRate: 0 }
    );
  }

  /** Record a successful or failed operation to update rolling health. */
  recordOutcome(id: string, ok: boolean): void {
    const cur = this.healthOf(id);
    // Exponential moving average of the error rate.
    const alpha = 0.2;
    const errorRate = cur.errorRate * (1 - alpha) + (ok ? 0 : 1) * alpha;
    this.health.set(id, {
      ...cur,
      errorRate,
      healthy: ok ? true : cur.healthy,
      lastOutageAt: ok ? cur.lastOutageAt : new Date().toISOString(),
    });
  }

  /** True if the provider had an outage within the deprioritization window. */
  recentlyOutaged(id: string, now = Date.now()): boolean {
    const h = this.healthOf(id);
    if (!h.lastOutageAt) return false;
    return now - Date.parse(h.lastOutageAt) < OUTAGE_DEPRIORITIZE_MS;
  }

  /** Refresh health for all providers from their adapters (background job). */
  async refreshHealth(): Promise<void> {
    await Promise.all(
      this.list().map(async (a) => {
        try {
          const h = await a.health();
          this.health.set(a.id, h);
        } catch {
          this.recordOutcome(a.id, false);
        }
      }),
    );
  }
}
