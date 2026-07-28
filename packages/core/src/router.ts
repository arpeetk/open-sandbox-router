/**
 * Routing engine. Runs ONLY at create time (a sandbox is bound to its provider for
 * life). Pipeline: filter (capability negotiation) -> score -> order. The service then
 * attempts candidates in order with create-time failover.
 */

import type { SandboxAdapter } from "./adapter.js";
import type { CapabilityManifest, NegotiationInput } from "./capabilities.js";
import { negotiate } from "./capabilities.js";
import { OsrError } from "./errors.js";
import type { ProviderRegistry } from "./registry.js";
import type { NormalizedSpec } from "./adapter.js";
import type { RoutingPreferences } from "./types.js";

export interface ScoringWeights {
  cost: number;
  latency: number;
  region: number;
  reliability: number;
  capability: number;
  preference: number;
}

/** Named strategies are sugar over weight presets. */
const STRATEGY_WEIGHTS: Record<string, ScoringWeights> = {
  balanced: { cost: 1, latency: 1, region: 1, reliability: 1.5, capability: 0.5, preference: 1 },
  cost: { cost: 3, latency: 0.5, region: 1, reliability: 1, capability: 0.25, preference: 0.5 },
  latency: { cost: 0.5, latency: 3, region: 1.5, reliability: 1, capability: 0.25, preference: 0.5 },
  order: { cost: 0.25, latency: 0.25, region: 0.5, reliability: 1, capability: 0.25, preference: 5 },
};

export interface ScoredCandidate {
  provider: string;
  score: number;
  estimatedUsdPerHour: number;
  breakdown: Record<string, number>;
}

export interface RoutePlan {
  candidates: ScoredCandidate[];
  excluded: { provider: string; reason: string }[];
}

function weightsFor(routing: RoutingPreferences): ScoringWeights {
  const strat = routing.strategy ?? "balanced";
  if (strat.startsWith("pin:")) return STRATEGY_WEIGHTS.order!;
  return STRATEGY_WEIGHTS[strat] ?? STRATEGY_WEIGHTS.balanced!;
}

function regionMatchScore(glob: string | undefined, regions: string[]): number {
  if (!glob) return 0.5;
  return regions.some((r) => r === glob) ? 1 : regions.length > 0 ? 0.75 : 0.5;
}

export class Router {
  constructor(private readonly registry: ProviderRegistry) {}

  /**
   * Produce an ordered list of provider candidates for a create request.
   * Throws NoCompliantProvider when negotiation yields an empty candidate set.
   */
  plan(
    negotiation: NegotiationInput,
    spec: NormalizedSpec,
  ): RoutePlan {
    const routing = negotiation.routing ?? {};

    // Pin bypasses scoring entirely (reproducibility / power users).
    const pin = routing.strategy?.startsWith("pin:") ? routing.strategy.slice(4) : undefined;
    if (pin) {
      if (!this.registry.has(pin)) {
        throw new OsrError("NoCompliantProvider", `pinned provider "${pin}" is not registered`);
      }
      const adapter = this.registry.get(pin);
      return {
        candidates: [
          this.scoreOne(adapter.capabilities(), spec, routing, weightsFor(routing), 0, []),
        ],
        excluded: [],
      };
    }

    const { candidates: manifests, excluded } = negotiate(this.registry.manifests(), negotiation);

    if (manifests.length === 0) {
      throw new OsrError("NoCompliantProvider", "no provider satisfies the request", {
        details: { excluded },
      });
    }

    const weights = weightsFor(routing);
    const order = routing.order ?? [];
    const preferred = negotiation.preferredCapabilities ?? [];
    const scored = manifests
      .map((m) => this.scoreOne(m, spec, routing, weights, order.indexOf(m.provider), preferred))
      // Enforce hard budget ceiling.
      .filter((c) => {
        if (routing.maxCostPerHourUsd === undefined) return true;
        return c.estimatedUsdPerHour <= routing.maxCostPerHourUsd;
      })
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      throw new OsrError("NoCompliantProvider", "all candidates exceed the cost ceiling", {
        details: { maxCostPerHourUsd: routing.maxCostPerHourUsd },
      });
    }

    return { candidates: scored, excluded };
  }

  private scoreOne(
    m: CapabilityManifest,
    spec: NormalizedSpec,
    routing: RoutingPreferences,
    w: ScoringWeights,
    orderIndex: number,
    preferred: string[],
  ): ScoredCandidate {
    const adapter: SandboxAdapter = this.registry.get(m.provider);
    const est = adapter.estimateCost(spec);
    const health = this.registry.healthOf(m.provider);

    // Normalize each factor into [0,1] where higher is better.
    const allCosts = this.registry.manifests().map((mm) =>
      this.registry.get(mm.provider).estimateCost(spec).usdPerHour,
    );
    const maxCost = Math.max(...allCosts, est.usdPerHour, 0.0001);
    const costScore = 1 - est.usdPerHour / maxCost; // cheaper -> higher

    const coldStart = health.coldStartMsP50 ?? m.coldStartMsP50;
    const latencyScore = 1 - Math.min(coldStart, 3000) / 3000; // faster -> higher

    const regionScore = regionMatchScore(routing.region, m.regions);
    const reliabilityScore = 1 - health.errorRate;
    const capabilityScore = preferredBonus(m, preferred);
    const preferenceScore = orderIndex >= 0 ? 1 / (orderIndex + 1) : 0;

    const breakdown = {
      cost: w.cost * costScore,
      latency: w.latency * latencyScore,
      region: w.region * regionScore,
      reliability: w.reliability * reliabilityScore,
      capability: w.capability * capabilityScore,
      preference: w.preference * preferenceScore,
    };

    let score = Object.values(breakdown).reduce((a, b) => a + b, 0);

    // Penalties: recent outage strongly deprioritizes without hard-excluding.
    if (this.registry.recentlyOutaged(m.provider)) {
      score -= 100;
      breakdown.reliability -= 100;
    }

    return { provider: m.provider, score, estimatedUsdPerHour: est.usdPerHour, breakdown };
  }
}

function preferredBonus(m: CapabilityManifest, prefs: string[]): number {
  if (prefs.length === 0) return 0;
  const granted = prefs.filter((c) => m.features[c as keyof typeof m.features]).length;
  return granted / prefs.length;
}
