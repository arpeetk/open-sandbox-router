/**
 * Capability model and create-time negotiation.
 *
 * Because sandbox providers diverge sharply in what they support, capability
 * negotiation is first-class: a create request declares required capabilities, and
 * the router filters the candidate set BEFORE scoring. Unmet requirements fail loud
 * (NoCompliantProvider) rather than silently degrading.
 */

import type {
  CapabilityName,
  CostModel,
  IsolationLevel,
  ResourceSpec,
  RoutingPreferences,
} from "./types.js";
import { ISOLATION_RANK } from "./types.js";

export interface CapabilityLimits {
  maxVcpu: number;
  maxMemoryMB: number;
  maxDiskMB: number;
  maxTtlSeconds: number;
  maxConcurrent: number;
}

export interface CapabilityManifest {
  provider: string;
  isolation: IsolationLevel;
  /** Runtimes/templates the provider can serve (e.g. "python-3.12", "node-20"). */
  runtimes: string[];
  features: Record<CapabilityName, boolean>;
  limits: CapabilityLimits;
  regions: string[];
  /** Baseline observed cold-start; the health monitor may refine this at runtime. */
  coldStartMsP50: number;
  costModel: CostModel;
}

/** Reasons a provider was excluded from the candidate set (for diagnostics). */
export interface ExclusionReason {
  provider: string;
  reason: string;
}

export interface NegotiationResult {
  candidates: CapabilityManifest[];
  excluded: ExclusionReason[];
}

export interface NegotiationInput {
  requiredCapabilities: CapabilityName[];
  preferredCapabilities?: CapabilityName[];
  resources?: ResourceSpec;
  template?: string;
  ttlSeconds?: number;
  routing?: RoutingPreferences;
}

function regionMatches(glob: string | undefined, regions: string[]): boolean {
  if (!glob) return true;
  const re = new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return regions.some((r) => re.test(r));
}

function needsGpu(resources?: ResourceSpec): boolean {
  return resources?.gpu !== undefined && resources.gpu !== 0;
}

/**
 * Filter providers to those that satisfy ALL required capabilities and hard policy
 * constraints. Returns both the surviving candidates and why others were excluded.
 */
export function negotiate(
  manifests: CapabilityManifest[],
  input: NegotiationInput,
): NegotiationResult {
  const candidates: CapabilityManifest[] = [];
  const excluded: ExclusionReason[] = [];
  const routing = input.routing ?? {};
  const required = new Set<CapabilityName>(input.requiredCapabilities);
  if (needsGpu(input.resources)) required.add("gpu");
  if (input.template) required.add("customImage");

  const isolationFloor: IsolationLevel | undefined = routing.isolationFloor;
  const allow = routing.allow ? new Set(routing.allow) : undefined;
  const deny = routing.deny ? new Set(routing.deny) : undefined;

  for (const m of manifests) {
    const exclude = (reason: string) => excluded.push({ provider: m.provider, reason });

    if (allow && !allow.has(m.provider)) {
      exclude("not in allow-list");
      continue;
    }
    if (deny?.has(m.provider)) {
      exclude("in deny-list");
      continue;
    }

    const missing = [...required].filter((cap) => !m.features[cap]);
    if (missing.length > 0) {
      exclude(`missing capabilities: ${missing.join(", ")}`);
      continue;
    }

    if (isolationFloor && ISOLATION_RANK[m.isolation] < ISOLATION_RANK[isolationFloor]) {
      exclude(`isolation ${m.isolation} below floor ${isolationFloor}`);
      continue;
    }

    if (!regionMatches(routing.region, m.regions)) {
      exclude(`no region matching "${routing.region}"`);
      continue;
    }

    if (input.template && m.runtimes.length > 0 && !m.runtimes.includes(input.template)) {
      // A provider with a declared runtime list that doesn't include the template is
      // only eligible if it can build custom images (checked via `customImage` above).
      // If it can build, we keep it; the build step resolves the template later.
    }

    const res = input.resources ?? {};
    if (res.vcpu && res.vcpu > m.limits.maxVcpu) {
      exclude(`vcpu ${res.vcpu} exceeds max ${m.limits.maxVcpu}`);
      continue;
    }
    if (res.memoryMB && res.memoryMB > m.limits.maxMemoryMB) {
      exclude(`memory ${res.memoryMB}MB exceeds max ${m.limits.maxMemoryMB}MB`);
      continue;
    }
    if (input.ttlSeconds && input.ttlSeconds > m.limits.maxTtlSeconds) {
      exclude(`ttl ${input.ttlSeconds}s exceeds max ${m.limits.maxTtlSeconds}s`);
      continue;
    }

    candidates.push(m);
  }

  return { candidates, excluded };
}

/** Compute the granted capability list a caller sees for a resolved provider. */
export function grantedCapabilities(m: CapabilityManifest): CapabilityName[] {
  return (Object.keys(m.features) as CapabilityName[]).filter((c) => m.features[c]);
}
