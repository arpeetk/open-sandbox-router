/**
 * Assembles the control plane from environment configuration: which provider adapters
 * to register, BYOK credential resolution, the binding store, and the metering sink.
 *
 * This wires the in-memory / simulated pieces by default so the gateway runs out of the
 * box. Swap InMemoryBindingStore for the Postgres implementation and the SimulatedKubeApi
 * for the real client to run against live infrastructure.
 */

import {
  InMemoryBindingStore,
  ProviderRegistry,
  SandboxService,
  type BindingStore,
  type CredentialProvider,
  type ProviderCreds,
} from "@osr/core";
import { createE2bAdapter } from "@osr/adapter-e2b";
import { createModalAdapter } from "@osr/adapter-modal";
import { createVercelAdapter } from "@osr/adapter-vercel";
import { createKubernetesAdapter, SimulatedKubeApi } from "@osr/adapter-kubernetes";
import { InMemoryMeter } from "./metering.js";

/** BYOK credential provider that reads provider secrets from environment variables. */
export class EnvCredentialProvider implements CredentialProvider {
  async credentialsFor(_tenant: string, provider: string): Promise<ProviderCreds> {
    const prefix = `OSR_${provider.toUpperCase()}_`;
    const creds: ProviderCreds = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v && k.startsWith(prefix)) creds[k.slice(prefix.length).toLowerCase()] = v;
    }
    return creds;
  }
}

function buildRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const enabled = (process.env.OSR_PROVIDERS ?? "e2b,modal,vercel,kubernetes")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const p of enabled) {
    switch (p) {
      case "e2b":
        registry.register(createE2bAdapter());
        break;
      case "modal":
        registry.register(createModalAdapter({ real: process.env.OSR_MODAL_REAL === "1" }));
        break;
      case "vercel":
        registry.register(createVercelAdapter({ real: process.env.OSR_VERCEL_REAL === "1" }));
        break;
      case "kubernetes":
        registry.register(
          createKubernetesAdapter(
            process.env.OSR_K8S_REAL === "1"
              ? { namespace: process.env.OSR_K8S_NAMESPACE }
              : { api: new SimulatedKubeApi() },
          ),
        );
        break;
      default:
        throw new Error(`unknown provider "${p}" in OSR_PROVIDERS`);
    }
  }
  return registry;
}

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
