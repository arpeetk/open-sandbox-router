/**
 * Assembles the control plane. The registry, BYOK credential resolution, and env loading
 * live in @osr/embed (shared with the CLI's local mode); the gateway adds its own binding
 * store and metering sink here.
 *
 * Swap InMemoryBindingStore for a Postgres implementation to run at scale.
 */

import { InMemoryBindingStore, SandboxService, type BindingStore } from "@osr/core";
import { buildRegistry, EnvCredentialProvider } from "@osr/embed";
import type { ProviderRegistry } from "@osr/core";
import { InMemoryMeter } from "./metering.js";

export { EnvCredentialProvider } from "@osr/embed";

export interface AppContext {
  registry: ProviderRegistry;
  bindings: BindingStore;
  meter: InMemoryMeter;
  service: SandboxService;
}

export function buildContext(): AppContext {
  const registry = buildRegistry();
  const bindings = new InMemoryBindingStore();
  const meter = new InMemoryMeter();
  const service = new SandboxService({
    registry,
    bindings,
    credentials: new EnvCredentialProvider(),
    meter,
  });
  return { registry, bindings, meter, service };
}

/**
 * Resolve the tenant for a request. In production this maps an OSR API key to a tenant;
 * here we accept an `x-osr-tenant` header and fall back to "default".
 */
export function resolveTenant(headers: Record<string, unknown>): string {
  const t = headers["x-osr-tenant"];
  return typeof t === "string" && t.length > 0 ? t : "default";
}
