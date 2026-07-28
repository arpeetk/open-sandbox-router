/**
 * Normalized cost estimation shared by all adapters. Maps each provider's cost model
 * (active-CPU vs session vs per-second-provisioned) to a comparable $/hour figure the
 * router can rank on. This is an ESTIMATE for routing/reporting, not an invoice.
 */

import type { CostEstimate, CostModel, NormalizedSpec } from "@osr/core";

/** Assumed active-CPU duty cycle for a bursty agent workload (for active-cpu billing). */
export const ACTIVE_CPU_DUTY_CYCLE = 0.4;

export function estimateCostFromModel(cm: CostModel, spec: NormalizedSpec): CostEstimate {
  const vcpu = spec.resources.vcpu ?? 1;
  const gb = (spec.resources.memoryMB ?? 512) / 1024;
  let usdPerHour: number;
  switch (cm.kind) {
    case "active-cpu":
      usdPerHour = vcpu * cm.usdPerVcpuHour * ACTIVE_CPU_DUTY_CYCLE + gb * cm.usdPerGbHourProvisioned;
      break;
    case "session":
      usdPerHour = cm.usdPerHour;
      break;
    case "per-second-provisioned":
      usdPerHour = vcpu * cm.usdPerVcpuHour + gb * cm.usdPerGbHour;
      break;
  }
  return { usdPerHour: Math.round(usdPerHour * 1e4) / 1e4, model: cm.kind };
}
