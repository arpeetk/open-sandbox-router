# Open Sandbox Router (OSR)

**A unified, provider-agnostic control plane for code-execution sandboxes.**
One API and SDK that intelligently provisions and operates ephemeral compute across
**E2B, Modal, Vercel Sandbox, Daytona, Runloop, Fly.io Sprites**, and self-hosted
**Kubernetes** — with capability negotiation, cost/latency-aware routing, and automatic
failover.

> Status: early scaffold (v0.1). Core routing, capability model, gateway, SDK, CLI and a
> self-hosted Kubernetes adapter are working end-to-end against simulated provider
> runtimes. Provider adapters ship with real capability manifests and cost models;
> wiring their live APIs is the next step. See [`SPEC.md`](./SPEC.md) for the full
> product & technical spec.

## Documentation

- **[Using the Router — practical guide](./docs/GUIDE.md)** — start here to create
  sandboxes, control routing, run work, and handle failures.
- **[Architecture](./ARCHITECTURE.md)** — the adapter boundary, request lifecycle, and
  how to add a provider.
- **[Product & technical spec](./SPEC.md)** — full rationale and roadmap.
- **[OpenAPI contract](./openapi/openapi.yaml)** — the REST API source of truth.

---

## Why

Sandbox providers have fragmented, incompatible APIs, divergent capabilities (snapshots,
GPU, ports, pause/resume), and non-comparable pricing (active-CPU vs session vs
provisioned). Committing to one vendor means lock-in and no failover. OSR makes sandboxes
a commodity you address through one interface.

**The key design fact:** a sandbox is a *stateful, long-lived* resource. Unlike a
stateless request, once it's created on a provider every later operation must go back to
that same provider. So **routing happens only at `create`**, and OSR keeps a durable
`sandbox → provider` binding for session affinity.

## Architecture

```
 SDK / CLI ──▶ Gateway (control plane) ──▶ Adapter ──▶ Provider
                 │  routing engine (filter → score → failover)
                 │  capability registry + health monitor
                 │  sandbox↔provider binding store (session affinity)
                 │  BYOK secrets · metering · policy
                 └────────────────────────────────────────────────
   Adapters: e2b · modal · vercel · kubernetes (self-hosted) · …
```

## Repo layout

| Package | What it is |
|---|---|
| `@osr/core` | Types, adapter contract, capability model + negotiation, error taxonomy, **routing engine**, binding store, orchestrating service |
| `@osr/adapter-sim` | Simulated in-memory runtime + base adapter (backs stubs, tests, the demo) |
| `@osr/adapter-modal` / `-vercel` | **Live** provider adapters wired to the real `modal` and `@vercel/sandbox` SDKs (with a simulated fallback) |
| `@osr/adapter-e2b` | Provider adapter (real manifest/cost; live `@e2b/sdk` wiring is the next TODO) |
| `@osr/adapter-kubernetes` | **Self-hosted** reference adapter — runs each sandbox as a Pod (gVisor/Kata/Firecracker RuntimeClass) |
| `@osr/gateway` | Fastify control-plane server exposing the unified REST API |
| `@osr/sdk` | TypeScript client SDK with an ergonomic `Sandbox` handle |
| `@osr/cli` | `osr` command-line interface |
| `openapi/openapi.yaml` | Contract source of truth |
| `sdk-python/` | Python SDK skeleton |
| `deploy/` | Kubernetes deployment + Helm values for the gateway |

## Quickstart

Requires Node 20+ and pnpm 9.

```bash
corepack enable
pnpm install
pnpm demo        # end-to-end library-mode walkthrough (no network)
pnpm test        # unit + gateway integration tests
pnpm typecheck
```

### Run the gateway

```bash
pnpm gateway               # listens on :8080 (PORT to override)
curl localhost:8080/v1/providers
```

### Use the SDK

```ts
import { OSR } from "@osr/sdk";

const osr = new OSR({ baseUrl: "http://localhost:8080" });

// Router picks the best provider for the constraints; you never name one.
const sbx = await osr.sandboxes.create({
  template: "python-3.12",
  requiredCapabilities: ["runCode", "filesystem"],
  routing: { strategy: "cost", isolationFloor: "microvm", region: "us-*" },
});

await sbx.fs.write("/work/data.txt", "hello");
const { stdout } = await sbx.run("cat", ["/work/data.txt"]);   // "hello"
console.log(`ran on provider: ${sbx.provider}`);
await sbx.destroy();
```

### Use the CLI

```bash
pnpm cli -- providers                                   # list providers + capabilities
pnpm cli -- plan --require runCode --strategy cost      # dry-run routing
pnpm cli -- create --template python-3.12 --require runCode --strategy latency
pnpm cli -- ls
pnpm cli -- exec <id> -- echo hello
```

## What works today

- **Capability negotiation** — required capabilities filter the candidate set before
  scoring; unmet requirements fail loud (`NoCompliantProvider`) instead of silently
  degrading.
- **Routing engine** — `cost` / `latency` / `order` / `balanced` / `pin:<provider>`
  strategies over a weighted score (cost, cold-start, region, reliability, capability,
  preference), with hard guardrails (allow/deny, region, isolation floor, budget).
- **Create-time failover** — transparently tries the next candidate on
  `CapacityError` / `RateLimited` / `Timeout` / `ProviderDown`; never fails over on
  `AuthError`.
- **Session affinity** — every op after create is dispatched to the sandbox's home
  provider via a durable binding.
- **Unified ops** — `exec` and `runCode` (SSE-streamed), filesystem read/write/list,
  port exposure, lifecycle.
- **Self-hosted Kubernetes adapter** — Pod-per-sandbox with a real `@kubernetes/client-node`
  path and a simulated path so it runs without a cluster.

## Configuration (gateway)

| Env | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `OSR_PROVIDERS` | `e2b,modal,vercel,kubernetes` | Adapters to register |
| `OSR_K8S_REAL` | unset | `1` uses the real cluster client instead of the simulator |
| `OSR_K8S_NAMESPACE` | `osr-sandboxes` | Namespace for sandbox Pods |
| `OSR_MODAL_REAL` | unset | `1` uses the live Modal SDK instead of the simulator |
| `OSR_VERCEL_REAL` | unset | `1` uses the live Vercel Sandbox SDK instead of the simulator |
| `OSR_<PROVIDER>_<KEY>` | — | BYOK provider secrets (see below) |

### Live provider adapters

`@osr/adapter-modal` and `@osr/adapter-vercel` are wired to the real vendor SDKs
(`modal`, `@vercel/sandbox` — declared as optional peer dependencies). Each factory
defaults to a **simulated** runtime so the demo and tests need no credentials; pass
`{ real: true }` (or set the env flag above) to hit the live API. BYOK credentials are
resolved per request from environment variables:

| Provider | Env vars |
|---|---|
| Modal | `OSR_MODAL_TOKEN_ID`, `OSR_MODAL_TOKEN_SECRET` |
| Vercel | `OSR_VERCEL_TOKEN`, `OSR_VERCEL_TEAM_ID`, `OSR_VERCEL_PROJECT_ID` (or a `VERCEL_OIDC_TOKEN`) |

```ts
// direct library use of a live adapter
import { createModalAdapter } from "@osr/adapter-modal";
const modal = createModalAdapter({ real: true });   // uses the modal SDK

import { createVercelAdapter } from "@osr/adapter-vercel";
const vercel = createVercelAdapter({ real: true });  // uses @vercel/sandbox
```

Install the vendor SDK alongside the adapter to use the live path:
`pnpm add modal` / `pnpm add @vercel/sandbox`.

## Roadmap

See [`SPEC.md`](./SPEC.md) §3.9. Modal and Vercel adapters are now wired to their live
SDKs; near-term: live E2B wiring, a portable Dockerfile→per-provider template builder,
snapshot/pause where supported, direct-connect mode, Postgres binding store, and
normalized cost/budget enforcement.

## License

Apache-2.0.
