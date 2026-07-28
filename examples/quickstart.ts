/**
 * End-to-end quickstart in LIBRARY MODE (no gateway, no network). It wires the router,
 * registry, and adapters directly, then:
 *
 *   1. inspects where a request would be routed (dry-run)
 *   2. creates a sandbox with the "cost" strategy
 *   3. writes a file, runs a command, and reads output back
 *   4. demonstrates create-time failover when the cheapest provider is down
 *
 * Run: pnpm demo
 */

import {
  InMemoryBindingStore,
  ProviderRegistry,
  SandboxService,
  type CredentialProvider,
  type ProviderCreds,
} from "@osr/core";
import { createE2bAdapter } from "@osr/adapter-e2b";
import { createModalAdapter } from "@osr/adapter-modal";
import { createVercelAdapter } from "@osr/adapter-vercel";
import { createKubernetesAdapter, SimulatedKubeApi } from "@osr/adapter-kubernetes";
import { SimAdapter } from "@osr/adapter-sim";
import { vercelManifest } from "@osr/adapter-vercel";

const noCreds: CredentialProvider = {
  async credentialsFor(_t: string, _p: string): Promise<ProviderCreds> {
    return {};
  },
};

function banner(title: string): void {
  console.log("\n" + "=".repeat(64) + `\n  ${title}\n` + "=".repeat(64));
}

async function main(): Promise<void> {
  const registry = new ProviderRegistry();
  registry.register(createE2bAdapter());
  registry.register(createModalAdapter());
  registry.register(createVercelAdapter());
  registry.register(createKubernetesAdapter({ api: new SimulatedKubeApi() }));

  const service = new SandboxService({
    registry,
    bindings: new InMemoryBindingStore(),
    credentials: noCreds,
  });
  const ctx = { tenant: "demo" };

  // 1. Dry-run routing: rank providers for a filesystem workload under "cost",
  //    giving a bonus to providers that also offer a stateful code interpreter.
  banner("1. Route plan (require: filesystem, prefer: runCode, strategy: cost)");
  const plan = service.planRoute({
    requiredCapabilities: ["filesystem"],
    preferredCapabilities: ["runCode"],
    routing: { strategy: "cost" },
  });
  for (const c of plan.candidates) {
    console.log(`  ${c.provider.padEnd(12)} score=${c.score.toFixed(3)}  ~$${c.estimatedUsdPerHour}/hr`);
  }
  if (plan.excluded.length) {
    console.log("  excluded:");
    for (const e of plan.excluded) console.log(`    ${e.provider}: ${e.reason}`);
  }

  // 2. Create + operate.
  banner("2. Create a Python sandbox and run work on it");
  const { sandbox } = await service.create(
    { template: "python-3.12", requiredCapabilities: ["runCode", "filesystem"], routing: { strategy: "cost" } },
    ctx,
  );
  console.log(`  created ${sandbox.id} on "${sandbox.provider}" (${sandbox.region})`);

  await service.fsWrite(sandbox.id, "/work/data.txt", new TextEncoder().encode("hello sandbox"));
  const files = await service.fsList(sandbox.id, "/work");
  console.log(`  files: ${files.map((f) => f.path).join(", ")}`);

  let stdout = "";
  for await (const ev of service.exec(sandbox.id, { cmd: "cat", args: ["/work/data.txt"] })) {
    if (ev.type === "stdout") stdout += ev.data;
  }
  console.log(`  exec "cat /work/data.txt" -> ${JSON.stringify(stdout)}`);
  await service.destroy(sandbox.id);
  console.log(`  destroyed ${sandbox.id}`);

  // 3. Capability negotiation: require snapshot (Modal + Vercel support it; E2B and
  //    Kubernetes do not, so they are excluded before scoring).
  banner("3. Require snapshot (E2B and Kubernetes excluded)");
  const snapPlan = service.planRoute({ requiredCapabilities: ["snapshot"] });
  console.log(`  candidates: ${snapPlan.candidates.map((c) => c.provider).join(", ") || "(none)"}`);
  console.log(`  excluded:   ${snapPlan.excluded.map((e) => `${e.provider}(${e.reason})`).join(", ")}`);

  // 4. Create-time failover: knock out the cheapest provider and watch OSR fail over.
  banner("4. Failover: cheapest provider returns CapacityError");
  const failing = new ProviderRegistry();
  // A cheap provider that always fails create, plus a healthy fallback.
  failing.register(new SimAdapter({ manifest: { ...vercelManifest, provider: "cheapo", costModel: { kind: "session", usdPerHour: 0.01 } }, failCreateWith: "CapacityError" }));
  failing.register(createModalAdapter());
  const failService = new SandboxService({
    registry: failing,
    bindings: new InMemoryBindingStore(),
    credentials: noCreds,
  });
  const outcome = await failService.create(
    { requiredCapabilities: ["filesystem"], routing: { strategy: "cost" } },
    ctx,
  );
  console.log(`  attempts: ${outcome.attempts.map((a) => `${a.provider}${a.error ? " (" + a.error + ")" : " OK"}`).join(" -> ")}`);
  console.log(`  landed on: "${outcome.sandbox.provider}"`);

  banner("Done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
