import { ProviderRegistry } from "@osr/core";
import { createE2bAdapter } from "@osr/adapter-e2b";
import { createModalAdapter } from "@osr/adapter-modal";
import { createVercelAdapter } from "@osr/adapter-vercel";
import { createKubernetesAdapter, SimulatedKubeApi } from "@osr/adapter-kubernetes";

export interface BuildRegistryOptions {
  /** Comma-separated provider ids; defaults to OSR_PROVIDERS env or all four. */
  providers?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Assemble a ProviderRegistry from environment config. Each provider is registered in its
 * simulated form by default; the `OSR_<PROVIDER>_REAL=1` flags switch to the live SDKs.
 * Shared by the gateway and the CLI's local mode so both wire providers identically.
 */
export function buildRegistry(opts: BuildRegistryOptions = {}): ProviderRegistry {
  const env = opts.env ?? process.env;
  const registry = new ProviderRegistry();
  const enabled = (opts.providers ?? env.OSR_PROVIDERS ?? "e2b,modal,vercel,kubernetes")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const p of enabled) {
    switch (p) {
      case "e2b":
        registry.register(createE2bAdapter());
        break;
      case "modal":
        registry.register(createModalAdapter({ real: env.OSR_MODAL_REAL === "1" }));
        break;
      case "vercel":
        registry.register(createVercelAdapter({ real: env.OSR_VERCEL_REAL === "1" }));
        break;
      case "kubernetes":
        registry.register(
          createKubernetesAdapter(
            env.OSR_K8S_REAL === "1"
              ? { namespace: env.OSR_K8S_NAMESPACE }
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
