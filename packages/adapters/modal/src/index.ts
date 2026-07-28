/**
 * Modal adapter.
 *
 * `createModalAdapter()` returns either the real `modal`-SDK-backed adapter or the
 * simulated one. Defaults to simulated so demos/tests run without credentials; pass
 * `{ real: true }` (or set OSR_MODAL_REAL=1 in the gateway) to hit the live API.
 */

import type { SandboxAdapter } from "@osr/core";
import { SimAdapter, type SimAdapterConfig } from "@osr/adapter-sim";
import { modalManifest } from "./manifest.js";
import { ModalSandboxAdapter, type ModalAdapterConfig } from "./real.js";

export { modalManifest } from "./manifest.js";
export { ModalSandboxAdapter } from "./real.js";

export interface ModalAdapterOptions extends ModalAdapterConfig {
  /** Use the real modal SDK. Defaults to false (simulated). */
  real?: boolean;
  /** Inject a create failure (simulated mode only) to exercise failover. */
  failCreateWith?: SimAdapterConfig["failCreateWith"];
}

export function createModalAdapter(opts: ModalAdapterOptions = {}): SandboxAdapter {
  if (opts.real) return new ModalSandboxAdapter({ appName: opts.appName });
  return new SimAdapter({ manifest: modalManifest, failCreateWith: opts.failCreateWith });
}
