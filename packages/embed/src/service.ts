import {
  InMemoryBindingStore,
  ProviderRegistry,
  SandboxService,
  type BindingStore,
  type CredentialProvider,
  type Meter,
} from "@osr/core";
import { buildRegistry } from "./registry.js";
import { EnvCredentialProvider } from "./credentials.js";

export interface EmbeddedServiceOptions {
  registry?: ProviderRegistry;
  bindings?: BindingStore;
  credentials?: CredentialProvider;
  meter?: Meter;
}

export interface EmbeddedService {
  service: SandboxService;
  registry: ProviderRegistry;
  bindings: BindingStore;
  credentials: CredentialProvider;
}

/**
 * Build a ready-to-use SandboxService with its registry, credential provider, and binding
 * store. This is the in-process equivalent of standing up the gateway — the CLI's local
 * mode uses it with a FileBindingStore so state persists across invocations.
 */
export function buildEmbeddedService(opts: EmbeddedServiceOptions = {}): EmbeddedService {
  const registry = opts.registry ?? buildRegistry();
  const bindings = opts.bindings ?? new InMemoryBindingStore();
  const credentials = opts.credentials ?? new EnvCredentialProvider();
  const service = new SandboxService({ registry, bindings, credentials, meter: opts.meter });
  return { service, registry, bindings, credentials };
}
