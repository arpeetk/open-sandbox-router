# Architecture

Open Sandbox Router (OSR) is a control plane that makes code-execution sandboxes a
commodity: you write against one interface, and OSR places each workload on the best
provider by cost, latency, capability, and availability — with automatic failover.

This document explains the internal structure. For how to *use* it, see
[`docs/GUIDE.md`](./docs/GUIDE.md). For the full product/technical rationale, see
[`SPEC.md`](./SPEC.md).

## The one idea that shapes everything

A sandbox is a **stateful, long-lived resource**, not an independent request. Once it's
created on a provider, every later operation (`exec`, filesystem, ports) must go back to
that *same* provider. Three consequences:

1. **Routing happens only at `create`.** Afterwards the sandbox is bound to its home
   provider for life (session affinity).
2. **Capability negotiation is first-class.** Providers diverge sharply (snapshots, GPU,
   ports, isolation). A create request declares required capabilities; the router filters
   candidates *before* scoring and fails loud rather than silently degrading.
3. **Failover splits in two.** Create-time failover is cheap and always on. Mid-session
   failover needs snapshot/migration and is opt-in.

## The adapter boundary

The single most important boundary: **the core knows only the `SandboxAdapter`
interface**. Vendor SDKs are imported in exactly one file per provider — that provider's
`real.ts` — and never leak upward.

```mermaid
flowchart TB
  subgraph clients [Clients]
    SDK["@osr/sdk (TS)"]
    PY["osr-sdk (Python)"]
    CLI["@osr/cli"]
  end

  subgraph control ["@osr/gateway (control plane)"]
    SVC[SandboxService]
    ROUTER[Router]
    REG[ProviderRegistry + health]
    BIND[(BindingStore)]
    METER[Metering]
  end

  SDK & PY & CLI -->|unified REST + SSE| SVC
  SVC --> ROUTER --> REG
  SVC --> BIND
  SVC --> METER

  subgraph iface ["SandboxAdapter interface (from @osr/core)"]
    A1[ModalSandboxAdapter]
    A2[VercelSandboxAdapter]
    A3[KubernetesAdapter]
    A4[E2B / SimAdapter]
  end

  SVC --> iface

  A1 -->|only inside real.ts| M[[modal SDK]]
  A2 -->|only inside real.ts| V[["@vercel/sandbox SDK"]]
  A3 -->|only inside real.ts| K[["@kubernetes/client-node"]]
```

Everything above the interface line deals purely in normalized types (`Sandbox`,
`ExecEvent`, `CapabilityManifest`, `NormalizedSpec`). That is why the same
`create → exec → destroy` calls run unchanged on Modal, Vercel, or Kubernetes.

## Packages

| Package | Responsibility |
|---|---|
| `@osr/core` | Normalized types, `SandboxAdapter` contract, capability model + negotiation, error taxonomy, **routing engine**, binding store, `SandboxService` |
| `@osr/adapter-sim` | Simulated in-memory runtime + `SimAdapter` base + shared cost helper |
| `@osr/adapter-modal` | Modal adapter (live `modal` SDK, simulated fallback) |
| `@osr/adapter-vercel` | Vercel adapter (live `@vercel/sandbox` SDK, simulated fallback) |
| `@osr/adapter-kubernetes` | Self-hosted adapter — Pod-per-sandbox via `@kubernetes/client-node` |
| `@osr/adapter-e2b` | E2B adapter (manifest/cost; live wiring TODO) |
| `@osr/gateway` | Fastify REST + SSE control plane, config/registry wiring, metering |
| `@osr/sdk` | TypeScript client with an ergonomic `Sandbox` handle |
| `@osr/cli` | `osr` command-line interface |

Each adapter package has an identical shape: `manifest.ts` (capability profile + cost
model), `real.ts` (the vendor-SDK implementation of `SandboxAdapter`), `index.ts`
(factory choosing real vs simulated). A vendor package appearing under an adapter's
`node_modules` (e.g. `@vercel/sandbox`, `modal`) is just its installed, git-ignored
dependency — not OSR code.

## Core types

```
SandboxAdapter        the provider contract every adapter implements
CapabilityManifest    what a provider supports: isolation, features, limits, regions, cost model
NormalizedSpec        a resolved create spec handed to an adapter (provider + region chosen)
Sandbox               provider-neutral view returned to callers
Binding               durable sandboxId -> { provider, providerRef, tenant, ... } record
ExecEvent / CodeEvent normalized streamed output
OsrError              normalized error taxonomy (drives failover decisions)
```

## Request lifecycle

### create — the only routing decision point

```mermaid
sequenceDiagram
  participant C as Client
  participant S as SandboxService
  participant R as Router
  participant Reg as Registry
  participant A as Adapter(s)
  participant B as BindingStore

  C->>S: create(request, {tenant})
  S->>R: plan(negotiation, spec)
  R->>Reg: manifests()
  R-->>S: ordered candidates (filter -> score) or NoCompliantProvider
  loop candidates, in scored order
    S->>A: create(spec, creds)
    alt success
      A-->>S: ProviderSandbox
      S->>B: create(binding)  %% sandbox now pinned to this provider
      S-->>C: { sandbox, attempts }
    else failover-eligible error (CapacityError/RateLimited/Timeout/ProviderDown)
      A-->>S: OsrError
      Note over S: try next candidate
    else non-failover error (AuthError, ...)
      A-->>S: OsrError (rethrown)
    end
  end
```

### every other op — session affinity

```mermaid
sequenceDiagram
  participant C as Client
  participant S as SandboxService
  participant B as BindingStore
  participant A as Home Adapter

  C->>S: exec / fs / destroy (sandboxId)
  S->>B: get(sandboxId)
  B-->>S: binding { provider, providerRef }
  S->>A: dispatch to the SAME provider
  A-->>C: result / stream
```

There is no re-routing of an existing sandbox — the binding is authoritative.

## Routing engine

Runs only at create. Pipeline: **filter → score → order → attempt with failover.**

1. **Filter (capability negotiation):** keep providers whose manifest satisfies *all*
   required capabilities and hard policy (allow/deny, region glob, `isolationFloor`,
   resource limits). Empty result → `NoCompliantProvider` with the unmet constraint.
2. **Score:** a weighted sum over normalized factors — cost, cold-start latency, region
   match, reliability (rolling error rate + recent-outage penalty), preferred-capability
   bonus, and explicit provider `order`. Named strategies (`cost`, `latency`, `order`,
   `balanced`, `pin:<provider>`) are presets over these weights.
3. **Guardrails:** providers estimated above `maxCostPerHourUsd` are dropped; recent
   outages are strongly deprioritized.
4. **Failover:** try candidates in scored order; on a failover-eligible `OsrError`, move
   to the next; exhausting the list yields `AllProvidersFailed`.

## State & deployment

- **Binding store** is the durable `sandbox → provider` map. `InMemoryBindingStore`
  ships for library mode / tests / the demo; a Postgres implementation backs the gateway.
- **Deployment modes:** gateway service (default), embedded library (import the service
  directly, no network hop), and direct-connect (roadmap — gateway routes + hands the
  SDK a scoped provider credential so exec I/O bypasses the control plane).

## Extending: add a provider

1. Create `packages/adapters/<name>` with `manifest.ts`, `real.ts`, `index.ts`.
2. Implement `SandboxAdapter`; translate vendor errors into the `OsrError` taxonomy so
   failover works.
3. Declare the vendor SDK as an optional peer dependency and load it via dynamic import.
4. Register the factory in `@osr/gateway`'s `config.ts` (and/or your own registry).

No changes to the core, router, or SDKs are required — that's the point of the boundary.
