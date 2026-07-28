/**
 * Vercel Sandbox adapter.
 *
 * `createVercelAdapter()` returns either the real `@vercel/sandbox`-backed adapter or the
 * simulated one. It defaults to simulated so demos/tests run without credentials; pass
 * `{ real: true }` (or set OSR_VERCEL_REAL=1 in the gateway) to hit the live API.
 */

import type { SandboxAdapter } from "@osr/core";
import { SimAdapter, type SimAdapterConfig } from "@osr/adapter-sim";
import { vercelManifest } from "./manifest.js";
import { VercelSandboxAdapter } from "./real.js";

export { vercelManifest } from "./manifest.js";
export { VercelSandboxAdapter } from "./real.js";

export interface VercelAdapterOptions {
  /** Use the real @vercel/sandbox SDK. Defaults to false (simulated). */
  real?: boolean;
  /** Inject a create failure (simulated mode only) to exercise failover. */
  failCreateWith?: SimAdapterConfig["failCreateWith"];
}

export function createVercelAdapter(opts: VercelAdapterOptions = {}): SandboxAdapter {
  if (opts.real) return new VercelSandboxAdapter();
  return new SimAdapter({ manifest: vercelManifest, failCreateWith: opts.failCreateWith });
}
