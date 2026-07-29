# Using the Router — A Practical Guide

This guide shows how to drive Open Sandbox Router (OSR) end to end: start it, create
sandboxes, control **where** they run, run work on them, and handle failure — without
your code ever hard-coding a provider.

- New to the design? Skim [`ARCHITECTURE.md`](../ARCHITECTURE.md) first.
- Want the full API contract? See [`openapi/openapi.yaml`](../openapi/openapi.yaml).

## Contents

1. [Mental model](#1-mental-model)
2. [Prerequisites](#2-prerequisites)
3. [Quick start — gateway mode](#3-quick-start--gateway-mode)
4. [Quick start — library mode](#4-quick-start--library-mode)
5. [Creating sandboxes](#5-creating-sandboxes)
6. [Controlling routing](#6-controlling-routing)
7. [Capabilities & negotiation](#7-capabilities--negotiation)
   - [7.5 Named, reusable sandboxes](#75-named-reusable-sandboxes)
8. [Running work on a sandbox](#8-running-work-on-a-sandbox)
   - [Pause, resume, snapshot & restore](#pause-resume-snapshot--restore-provider-dependent)
9. [Failover](#9-failover)
10. [Providers & credentials (simulated vs live)](#10-providers--credentials-simulated-vs-live)
11. [CLI reference](#11-cli-reference)
12. [Python SDK](#12-python-sdk)
13. [REST API (curl)](#13-rest-api-curl)
14. [Error handling](#14-error-handling)
15. [Configuration reference](#15-configuration-reference)
16. [Recipes](#16-recipes)

---

## 1. Mental model

Two things to internalize:

- **You describe requirements, not a provider.** You say "I need `filesystem` +
  `runCode`, cheapest, in the US, microVM isolation." OSR picks the provider.
- **Routing happens once, at create.** After that the sandbox is pinned to its home
  provider; every `exec`/`fs`/`destroy` call is dispatched back there automatically.

You can run OSR two ways:

| Mode | What it is | Use when |
|---|---|---|
| **Gateway** | A service you call over HTTP (REST + SSE) | Central policy, metering, multiple apps/tenants, polyglot clients |
| **Library** | Import `SandboxService` directly into a Node app | Single app, lowest latency, no network hop |

Both expose the same operations and semantics.

## 2. Prerequisites

- Node.js 20+ and pnpm 9 (`corepack enable`).
- Clone and install:
  ```bash
  git clone https://github.com/arpeetk/open-sandbox-router
  cd open-sandbox-router
  pnpm install
  ```
- Out of the box, all providers run against a **simulated** runtime — no credentials
  needed. See [§10](#10-providers--credentials-simulated-vs-live) to go live.

## 3. Quick start — gateway mode

Start the gateway (defaults to `:8080`, registers `e2b,modal,vercel,kubernetes`):

```bash
pnpm gateway
```

Then drive it with the TypeScript SDK:

```ts
import { OSR } from "@osr/sdk";

const osr = new OSR({ baseUrl: "http://localhost:8080" });

// Create — the router chooses the provider from your constraints.
const sbx = await osr.sandboxes.create({
  template: "python-3.12",
  requiredCapabilities: ["runCode", "filesystem"],
  routing: { strategy: "cost", isolationFloor: "microvm", region: "us-*" },
});
console.log(`running on: ${sbx.provider}`);   // e.g. "e2b"

// Operate — same calls regardless of which provider was picked.
await sbx.fs.write("/work/data.txt", "hello");
const { stdout } = await sbx.run("cat", ["/work/data.txt"]);   // "hello"

await sbx.destroy();
```

## 4. Quick start — library mode

Skip the gateway; wire the service into your app:

```ts
import {
  ProviderRegistry, SandboxService, InMemoryBindingStore,
  type CredentialProvider,
} from "@osr/core";
import { createModalAdapter } from "@osr/adapter-modal";
import { createVercelAdapter } from "@osr/adapter-vercel";

const registry = new ProviderRegistry();
registry.register(createModalAdapter());   // simulated by default; { real: true } to go live
registry.register(createVercelAdapter());

// BYOK: return each provider's credentials for a tenant.
const credentials: CredentialProvider = {
  async credentialsFor(_tenant, _provider) { return {}; },
};

const svc = new SandboxService({
  registry,
  bindings: new InMemoryBindingStore(),
  credentials,
});

const { sandbox } = await svc.create(
  { requiredCapabilities: ["filesystem"], routing: { strategy: "latency" } },
  { tenant: "my-app" },
);

await svc.fsWrite(sandbox.id, "/work/x", new TextEncoder().encode("hi"));
for await (const ev of svc.exec(sandbox.id, { cmd: "cat", args: ["/work/x"] })) {
  if (ev.type === "stdout") process.stdout.write(ev.data);
}
await svc.destroy(sandbox.id);
```

The rest of the guide uses the SDK (gateway mode). Library equivalents are noted where
the method names differ (`svc.fsWrite` vs `sbx.fs.write`, etc.).

## 5. Creating sandboxes

`create` accepts:

| Field | Type | Meaning |
|---|---|---|
| `template` | string | Portable runtime/image (`python-3.12`, `node-20`, `base`, or a custom template) |
| `resources` | `{ vcpu?, memoryMB?, diskMB?, gpu? }` | Requested resources; `gpu` implies the `gpu` capability |
| `ttlSeconds` | number | Auto-expiry; the reaper destroys the sandbox afterwards |
| `env` | `Record<string,string>` | Default env for commands |
| `requiredCapabilities` | `CapabilityName[]` | Must all be satisfied or `NoCompliantProvider` |
| `preferredCapabilities` | `CapabilityName[]` | Scoring bonus, not a filter |
| `routing` | `RoutingPreferences` | See [§6](#6-controlling-routing) |
| `providerOptions` | `Record<provider, object>` | Passthrough to a specific provider (e.g. `{ vercel: { ports: [3000] } }`) |
| `metadata` | `Record<string,string>` | Your tags |
| `idempotencyKey` | string | Dedupes retried creates — same key returns the same sandbox |

The result is a `SandboxHandle` (SDK) exposing `.id`, `.provider`, `.capabilities`, and
`.attempts` (the failover path taken, if any).

## 6. Controlling routing

All placement control lives under `routing`.

### Strategies

| `strategy` | Behavior |
|---|---|
| `balanced` *(default)* | Blended score across cost, latency, region, reliability |
| `cost` | Cheapest compliant provider (inverse-price weighting) |
| `latency` | Lowest expected cold-start for the region |
| `order` | Respect your explicit `order` list; first compliant + healthy wins |
| `pin:<provider>` | Bypass *ranking* — always this provider, if it's compliant (reproducibility) |

> `pin:` only skips *scoring* — it never skips capability negotiation or guardrails
> (`allow`/`deny`, `isolationFloor`, `region`, `maxCostPerHourUsd`). Pinning to a provider
> that doesn't satisfy your `requiredCapabilities` or is excluded by policy still raises
> `NoCompliantProvider`, exactly like the non-pinned path. Pinning is a ranking override
> for power users, not an escape hatch around what you asked for.

### Guardrails (hard constraints)

| Field | Effect |
|---|---|
| `allow: string[]` | Only these providers are eligible |
| `deny: string[]` | Exclude these providers |
| `region: string` | Glob match, e.g. `"us-*"`, `"eu-west"` |
| `isolationFloor` | `"microvm" \| "gvisor" \| "container"` — never place below this |
| `maxCostPerHourUsd` | Drop providers estimated above this ceiling |
| `order: string[]` | Priority list; also gives a scoring bonus under non-`order` strategies |
| `allowFallbacks` | `false` disables create-time failover (default `true`) |

### Dry-run: see where a request *would* go

Inspect placement without provisioning anything:

```ts
const plan = await osr.routePlan({
  requiredCapabilities: ["filesystem"],
  routing: { strategy: "cost", region: "us-*" },
});
// plan.candidates: [{ provider, score, estimatedUsdPerHour, breakdown }, ...] ranked
// plan.excluded:   [{ provider, reason }, ...]  e.g. "missing capabilities: runCode"
```

This is the fastest way to understand *why* a provider was or wasn't chosen — the
`breakdown` shows each scoring factor's contribution.

## 7. Capabilities & negotiation

Capabilities are the contract between what you need and what a provider offers.

`CapabilityName`: `exec`, `runCode`, `filesystem`, `exposePorts`, `pauseResume`,
`snapshot`, `persistentDisk`, `gpu`, `customImage`.

- **`requiredCapabilities`** filter the candidate set *before* scoring. If nothing
  qualifies you get a structured `NoCompliantProvider` error naming the unmet constraint —
  OSR never silently downgrades (e.g. it won't hand you a weaker isolation than asked).
- **`preferredCapabilities`** don't filter; they add a scoring bonus, so a provider that
  also offers the nice-to-have ranks higher.

Current provider profiles (see each adapter's `manifest.ts` for the source of truth):

| Capability | e2b | modal | vercel | kubernetes |
|---|:--:|:--:|:--:|:--:|
| `runCode` (stateful interpreter) | ✅ | — | — | — |
| `filesystem` | ✅ | ✅ | ✅ | ✅ |
| `exposePorts` | ✅ | ✅ | ✅ | ✅ |
| `snapshot` | — | ✅ | ✅ | — |
| `pauseResume` | ✅* | — | ✅ | — |
| `gpu` | — | ✅ | — | ✅ |
| isolation | microvm | gvisor | microvm | gvisor** |

\* E2B is still simulated end-to-end (see `@osr/adapter-e2b`'s TODO) — pause/resume work
against the simulator, not E2B's live API yet.
\*\* Kubernetes isolation depends on the cluster RuntimeClass (gVisor / Kata / Firecracker).

Every `true` above is genuinely reachable end-to-end — `SandboxService` exposes
`pause`/`resume`/`snapshot`, the gateway has REST routes for them, and both TS/Python
SDKs and the CLI expose them. Modal has no pause/resume primitive at all (only
`snapshotFilesystem`, i.e. baking the filesystem into a reusable Image), so `pauseResume`
stays honestly `false` there — see §8 below.

## 7.5 Named, reusable sandboxes

Pass `name` at create time for get-or-create semantics: if a live binding already exists
for `(tenant, name)`, it's returned as-is with no new provisioning.

```ts
const sbx = await osr.sandboxes.create({ name: "my-agent-workspace", template: "python-3.12" });
// ...later, from anywhere, same tenant...
const same = await osr.sandboxes.create({ name: "my-agent-workspace" }); // same sandbox, no-op
```

Where the provider has its own native named-sandbox support, the name is passed through
too (Vercel: `Sandbox.getOrCreate`; Modal: `sandboxes.fromName` with a create-on-not-found
fallback), so the sandbox is still reachable by name even if OSR's own binding store is
ever lost — defense in depth, not just an OSR-side cache.

List live manifests at runtime: `await osr.providers()` (or `osr providers` on the CLI).

## 8. Running work on a sandbox

### Commands (streaming)

```ts
for await (const ev of sbx.exec("pip", { args: ["install", "requests"] })) {
  if (ev.type === "stdout") process.stdout.write(ev.data);
  else if (ev.type === "stderr") process.stderr.write(ev.data);
  else if (ev.type === "exit") console.log("exit", ev.code);
}
```

Or collect the result in one call:

```ts
const { stdout, stderr, code } = await sbx.run("python", ["-c", "print(2 + 2)"]);
```

### Stateful code (interpreter session)

Only on providers advertising `runCode` (E2B today). The same `session` id reuses REPL
state across calls:

```ts
for await (const ev of sbx.runCode("import pandas as pd", { session: "s1" })) { /* ... */ }
for await (const ev of sbx.runCode("pd.DataFrame({'a':[1,2]}).sum()", { session: "s1" })) {
  if (ev.type === "result") console.log(ev.mime, ev.data);
}
```

Calling `runCode` on a provider without it returns `CapabilityUnsupported` — require it at
create time to guarantee a compliant provider.

### Filesystem

```ts
await sbx.fs.write("/work/app.py", "print('hi')");
const src = await sbx.fs.read("/work/app.py");
const entries = await sbx.fs.list("/work");     // [{ path, type, sizeBytes? }]
```

### Ports / preview URLs

```ts
// Declare the port at create time, then resolve its public URL.
const sbx = await osr.sandboxes.create({
  template: "node-20",
  requiredCapabilities: ["exposePorts"],
  providerOptions: { vercel: { ports: [3000] }, modal: { ports: [3000] } },
});
const { url } = await sbx.exposePort(3000);
```

### Lifecycle

```ts
const s = await osr.sandboxes.get(id);   // reconnect to an existing sandbox
await osr.sandboxes.list();              // all sandboxes for the tenant
await sbx.destroy();                     // tear down
```

`ttlSeconds` at create time is enforced by a reaper, not just stored — see §10's
`OSR_REAP_INTERVAL_MS`. Library/CLI users driving `SandboxService` directly can call
`service.reapExpired()` themselves on whatever schedule they like.

### Pause, resume, snapshot & restore (provider-dependent)

These require the provider to actually support them — check §7's table, or require the
capability at create time so negotiation guarantees it (`requiredCapabilities: ["snapshot"]`).
Calling one of these against an unsupported provider throws `CapabilityUnsupported`.

```ts
await sbx.pause();                 // e.g. Vercel: stop() — snapshots + pauses
await sbx.resume();                // e.g. Vercel: Sandbox.get({ resume: true })
// Vercel: `pause()` always leaves the sandbox resumable, even if it was created
// without a `name` (unnamed sandboxes default to non-persistent) — pause forces
// persistence on first. Verified live: without this, resume() fails with the
// provider's own `snapshot_not_found` error.

const snap = await sbx.snapshot();  // { provider, snapshotId } — opaque outside that provider
const clone = await osr.sandboxes.restore(snap, { requiredCapabilities: ["filesystem"] });
// `clone` is a genuinely NEW sandbox (new id) seeded from the snapshot's state.
```

`restore` is routed like `pin:<snapshot's provider>` — it still runs through full
capability negotiation and policy guardrails (allow/deny, budget), so a snapshot on a
provider your policy denies still fails loud with `NoCompliantProvider`, exactly like an
explicit pin would.

Snapshot semantics differ by provider — plan around the one you're on:
- **Vercel**: `pause` truly pauses *this* sandbox (auto-snapshot on stop); `restore`
  creates a new sandbox from that snapshot via `source: { type: "snapshot" }`.
- **Modal**: no pause/resume at all (`pauseResume: false` is accurate to the vendor,
  not a gap). `snapshot` bakes the filesystem into a reusable Image; `restore` always
  creates a brand-new sandbox from that image — there's no "this exact sandbox, paused."

## 9. Failover

Because routing is create-time, failover has two regimes:

- **Create-time failover (on by default).** If the chosen provider returns a transient
  failure — `CapacityError`, `RateLimited`, `Timeout`, or `ProviderDown` — OSR
  transparently tries the next-best candidate. `AuthError` and capability errors are
  *not* failed over (they'd fail everywhere or indicate a real misconfig). If every
  candidate fails you get `AllProvidersFailed` with per-attempt detail.

  ```ts
  const sbx = await osr.sandboxes.create({ requiredCapabilities: ["filesystem"] });
  console.log(sbx.attempts);
  // [{ provider: "cheapo", error: "CapacityError: ..." }, { provider: "modal" }]
  ```

  Disable with `routing: { allowFallbacks: false }`.

- **Mid-session failover / migration** (a running sandbox's provider degrades) requires
  snapshot + restore and is on the roadmap — see [`SPEC.md`](../SPEC.md) §4.8.

The router also **deprioritizes recently-failed providers** automatically (rolling error
rate + a penalty for outages in the last 30s), so repeated failures steer new placements
away from a struggling provider.

## 10. Providers & credentials (simulated vs live)

Every adapter defaults to a **simulated** in-memory runtime so you can develop and test
with no credentials. Switch a provider to its live SDK explicitly.

> **A simulated and a live provider use the exact same id** (`"vercel"` either way) —
> that's deliberate (routing shouldn't care), but it means you can't tell them apart from
> the provider name alone. Every provider and sandbox carries a `simulated: boolean`
> field precisely so this is never ambiguous: `osr providers` and `osr ls`/`osr create`
> print a `[SIMULATED]` tag whenever it's `true`. If you expect to be hitting a real
> vendor and don't see that tag disappear, `OSR_<PROVIDER>_REAL` or your credentials
> aren't actually being picked up — check `osr providers` first, before debugging
> anything else.
>
> **A sandbox created before a config change can become stranded.** `--local` mode
> rebuilds its registry fresh from your current environment on every invocation, so a
> sandbox created while a provider was simulated (e.g. `.env.local` got deleted or
> `OSR_VERCEL_REAL` wasn't set yet) will fail with a clear `NotFound` error — not a
> confusing vendor API error — if you later flip that provider to live and try to
> `exec`/`pause`/etc. on the same sandbox id. `osr rm <id>` still works in this case
> (cleanup is exempt, since there's nothing valid left for either adapter to act on) —
> just create a new sandbox afterward.

**Library mode:**

```ts
import { createModalAdapter } from "@osr/adapter-modal";
import { createVercelAdapter } from "@osr/adapter-vercel";

registry.register(createModalAdapter({ real: true }));    // uses the `modal` SDK
registry.register(createVercelAdapter({ real: true }));   // uses `@vercel/sandbox`
```

Install the vendor SDK alongside the adapter: `pnpm add modal` / `pnpm add @vercel/sandbox`.

**Gateway mode:** set the env flag and the provider goes live.

| Provider | Enable live | BYOK env vars |
|---|---|---|
| Modal | `OSR_MODAL_REAL=1` | `OSR_MODAL_TOKEN_ID`, `OSR_MODAL_TOKEN_SECRET` |
| Vercel | `OSR_VERCEL_REAL=1` | `OSR_VERCEL_TOKEN`, `OSR_VERCEL_TEAM_ID`, `OSR_VERCEL_PROJECT_ID` (or ambient `VERCEL_OIDC_TOKEN`) |
| Kubernetes | `OSR_K8S_REAL=1` | in-cluster / kubeconfig; `OSR_K8S_NAMESPACE` |

Credentials are resolved **per request** by the gateway's `EnvCredentialProvider`, which
maps `OSR_<PROVIDER>_<KEY>` env vars to the adapter's credential fields. In library mode,
supply your own `CredentialProvider` (e.g. reading from a vault per tenant).

```bash
OSR_VERCEL_REAL=1 \
OSR_VERCEL_TOKEN=... OSR_VERCEL_TEAM_ID=team_... OSR_VERCEL_PROJECT_ID=prj_... \
pnpm gateway
```

### Try it live against Modal and Vercel

Put your credentials in a git-ignored `.env.local` (never commit them):

```bash
cp .env.example .env.local     # then fill in your tokens
```

For **Vercel** you need all three of `OSR_VERCEL_TOKEN`, `OSR_VERCEL_TEAM_ID`,
`OSR_VERCEL_PROJECT_ID`, and the project must exist. Find/create them at
vercel.com → Account Settings → Tokens, and your team/project in their settings (or via
`GET https://api.vercel.com/v9/projects`). For **Modal**, either set
`OSR_MODAL_TOKEN_ID`/`OSR_MODAL_TOKEN_SECRET` or configure `~/.modal.toml`.

**Option A — one scripted run (both providers):**

```bash
pnpm demo:live
```

It reads `.env.local`, then for each provider with credentials: creates a real sandbox
(pinned to that provider), runs a version command, writes+reads a file, and destroys it.
Providers without credentials are skipped — nothing is provisioned for them. Expected:

```
=== MODAL (live) ===
  created sbx_… on "modal"  (…ms)
  exec python --version -> "Python 3.12.13"
  fs write+read /tmp/osr.txt -> "hello from OSR"
  destroyed
=== VERCEL (live) ===
  created sbx_… on "vercel"  (…ms)
  exec node --version -> "v22.22.2"
  ...
```

**Option A.5 — the full CLI e2e suite (every command, both providers):**

```bash
./examples/cli-e2e-live.sh
```

Spawns the actual built `osr` binary (not library calls) in `--local` mode and drives
every supported command against real Modal and Vercel: `providers`, `plan`, `create`
(plain, named get-or-create, `pin:<provider>`), `exec` (with and without `--`), `pause`/
`resume` (and confirms Modal correctly rejects pause with `CapabilityUnsupported`, since
its SDK has no such primitive), `snapshot` + `--from-snapshot` restore (asserting the
restored sandbox is genuinely new, not the same one), and `rm`. Cleans up everything it
creates on exit, including on failure. Prints a pass/fail count per assertion.

**Option B — the `osr` CLI in local mode (no gateway):**

`--local` embeds the router in-process and reads your `.env.local`, so you can drive real
providers straight from the CLI. Bindings persist to `~/.osr/bindings.json`, so a
`create` in one shell and an `exec` in another dispatch to the same sandbox.

```bash
pnpm cli:install     # once

# Vercel
VID=$(osr --local create --template node-20 --require filesystem --strategy pin:vercel | grep -oE 'sbx_[a-z0-9]+')
osr --local exec "$VID" -- node --version
osr --local rm "$VID"

# Modal
MID=$(osr --local create --template python-3.12 --require filesystem --strategy pin:modal | grep -oE 'sbx_[a-z0-9]+')
osr --local exec "$MID" -- python --version
osr --local rm "$MID"

# or let the router choose
osr --local plan --require filesystem --strategy cost
osr --local create --require filesystem --strategy cost
```

> **Cross-process session affinity requires a real provider.** Each `osr --local`
> invocation is a fresh process. The binding (`sandbox -> provider`) persists to disk, so
> a later `osr --local exec`/`rm` in a different shell correctly reconnects — but only if
> the provider's *sandbox itself* lives outside that process too. Real providers (Modal,
> Vercel with `OSR_MODAL_REAL=1` / `OSR_VERCEL_REAL=1`) satisfy this, since the sandbox
> runs on the vendor's infrastructure. Simulated providers (the default for every
> provider, including E2B and Kubernetes today) only exist in the memory of the process
> that created them, so a separate `exec`/`rm` process will get `NotFound` — that's
> expected, not a bug. If you want multi-command simulated testing, use the gateway
> instead (`pnpm gateway`): its adapters live for the process's lifetime, so simulated
> sandboxes persist across requests. When routing without a pin (e.g. `--strategy cost`),
> pass `--order` or `--allow` to keep the result on a real provider — otherwise the
> router may pick a simulated one.

**Option C — the gateway + `osr` CLI (client/server):**

```bash
set -a; source .env.local; set +a          # export creds into the gateway
OSR_PROVIDERS=modal,vercel pnpm gateway     # terminal 1
osr providers                               # terminal 2 (no --local -> uses the gateway)
osr create --template node-20 --require filesystem --strategy pin:vercel
```

> Note: `runCode` (stateful interpreter) is E2B-only — with Modal/Vercel, require
> `filesystem` and use `exec`. Always `rm`/`destroy` sandboxes you create so they don't
> bill while idle.

## 11. CLI reference

Install the `osr` command once — it bundles into a standalone binary linked onto your
PATH, so it runs on plain Node with no pnpm/tsx:

```bash
pnpm cli:install          # build + link `osr`   (undo: pnpm cli:uninstall)
osr --version
```

(For quick dev without installing, `pnpm cli -- <command>` still works.)

| Command | Description |
|---|---|
| `providers` | List providers + isolation + cold-start + capabilities |
| `plan [flags]` | Dry-run routing; prints candidates + exclusions |
| `create [flags]` | Create a sandbox; prints id, provider, and failover path |
| `ls` | List sandboxes |
| `exec <id> <cmd...>` | Run a command and stream output (`--` only needed if `<cmd>` itself has a `--flag`) |
| `rm <id>` | Destroy a sandbox |
| `pause <id>` / `resume <id>` | Pause/resume (provider-dependent) |
| `snapshot <id>` | Take a provider-native snapshot; prints `<provider>:<snapshotId>` |

Flags: `--template`, `--name <n>` (get-or-create by stable name), `--require <cap>`
(repeatable), `--prefer <cap>` (repeatable), `--strategy <s>`, `--region <r>`,
`--isolation <lvl>`, `--max-cost <usd>`, `--order <provider>` (repeatable), `--vcpu`,
`--memory`, `--from-snapshot <provider>:<snapshotId>` (restore), `--url`, `--tenant`.

```bash
osr create --name my-workspace --template node-20   # get-or-create; safe to run repeatedly
osr snapshot <id>                                    # -> "modal:im-01K..."
osr create --from-snapshot modal:im-01K...           # restore into a new sandbox
osr pause <id>   # provider-dependent; throws CapabilityUnsupported otherwise
osr resume <id>
```

```bash
OSR_URL=http://localhost:8080 osr plan --require gpu --strategy cost
OSR_URL=http://localhost:8080 osr create --template python-3.12 --require runCode
```

## 12. Python SDK

Dependency-free, mirrors the TS client. Start the gateway, then:

```python
from osr import OSR

osr = OSR(base_url="http://localhost:8080")

sbx = osr.create(
    template="python-3.12",
    required=["runCode", "filesystem"],
    routing={"strategy": "cost", "isolationFloor": "microvm"},
)
sbx.fs_write("/work/data.txt", "hello")
print(sbx.run("cat", ["/work/data.txt"]).stdout)   # -> hello
print("ran on:", sbx.provider)
sbx.destroy()
```

`create(**kwargs)` accepts `template`, `required`, `preferred`, `resources`,
`ttl_seconds`, `routing`, `metadata`. See [`sdk-python/`](../sdk-python/).

## 13. REST API (curl)

```bash
# where would this go?
curl -s localhost:8080/v1/route/plan -H 'content-type: application/json' \
  -d '{"requiredCapabilities":["filesystem"],"routing":{"strategy":"cost"}}'

# create
curl -s localhost:8080/v1/sandboxes -H 'content-type: application/json' \
  -d '{"template":"python-3.12","requiredCapabilities":["runCode"]}'

# exec (Server-Sent Events)
curl -sN localhost:8080/v1/sandboxes/<id>/exec -H 'content-type: application/json' \
  -d '{"cmd":"echo","args":["hi"]}'

# filesystem
curl -s localhost:8080/v1/sandboxes/<id>/fs/write -H 'content-type: application/json' \
  -d '{"path":"/work/f.txt","content":"data"}'
curl -s "localhost:8080/v1/sandboxes/<id>/fs/read?path=/work/f.txt"

# destroy
curl -s -X DELETE localhost:8080/v1/sandboxes/<id>

# catalog + usage
curl -s localhost:8080/v1/providers
curl -s localhost:8080/v1/usage
```

Pass a tenant with `-H 'x-osr-tenant: my-team'`. Full schema: `openapi/openapi.yaml`.

## 14. Error handling

Errors are structured. In the SDK they arrive as `OsrError` with a `.code`; over REST as
`{ "error": { "code, message, provider, details } }` with a matching HTTP status.

| Code | HTTP | Failover? | Meaning |
|---|---|:--:|---|
| `NoCompliantProvider` | 422 | — | No provider satisfies the required capabilities/policy |
| `CapabilityUnsupported` | 422 | — | Op needs a capability the home provider lacks |
| `CapacityError` | 503 | ✅ | Provider out of capacity |
| `RateLimited` | 429 | ✅ | Provider rate limit hit |
| `Timeout` | 504 | ✅ | Operation exceeded its deadline |
| `ProviderDown` | 502 | ✅ | Provider unreachable / 5xx |
| `AllProvidersFailed` | 503 | — | Every candidate failed during create |
| `AuthError` | 401 | — | Bad/expired provider credentials |
| `NotFound` | 404 | — | Sandbox/binding not found |
| `InvalidRequest` | 400 | — | Malformed request |

```ts
import { OsrError } from "@osr/core";
try {
  // No single provider currently offers BOTH runCode (E2B-only) and gpu (Modal/K8s-only)
  // — this deterministically fails loud rather than silently placing you somewhere that
  // can't actually satisfy one of the two.
  await osr.sandboxes.create({ requiredCapabilities: ["runCode", "gpu"], resources: { gpu: 1 } });
} catch (e) {
  if (e instanceof OsrError && e.code === "NoCompliantProvider") {
    console.error("relax a constraint:", e.details);
  } else throw e;
}
```

## 15. Configuration reference

Gateway environment variables:

| Env | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `OSR_PROVIDERS` | `e2b,modal,vercel,kubernetes` | Adapters to register |
| `OSR_MODAL_REAL` | unset | `1` → live Modal SDK |
| `OSR_VERCEL_REAL` | unset | `1` → live Vercel SDK |
| `OSR_K8S_REAL` | unset | `1` → real cluster client |
| `OSR_K8S_NAMESPACE` | `osr-sandboxes` | Namespace for sandbox Pods |
| `OSR_<PROVIDER>_<KEY>` | — | BYOK provider secrets (see [§10](#10-providers--credentials-simulated-vs-live)) |
| `OSR_REAP_INTERVAL_MS` | `60000` | How often the TTL reaper sweeps for expired sandboxes; `0` disables it |
| `OSR_URL` | `http://localhost:8080` | Base URL used by the CLI |
| `OSR_TENANT` | `default` | Tenant used by the CLI |
| `OSR_LOCAL` | unset | `1` makes the CLI default to `--local` mode |
| `OSR_STATE_DIR` | `~/.osr` | Where `--local` mode persists its binding store |

## 16. Recipes

**Cheapest microVM in the EU:**
```ts
routing: { strategy: "cost", isolationFloor: "microvm", region: "eu-*" }
```

**Budget-capped fan-out** (skip anything over $0.20/hr):
```ts
routing: { strategy: "cost", maxCostPerHourUsd: 0.2 }
```

**GPU workload** (only GPU-capable providers survive negotiation):
```ts
{ resources: { gpu: 1 }, requiredCapabilities: ["gpu"], routing: { strategy: "latency" } }
```

**Reproducible placement** (always the same provider):
```ts
routing: { strategy: "pin:modal" }
```

**Prefer a provider but allow fallback:**
```ts
routing: { strategy: "order", order: ["e2b", "modal"], allowFallbacks: true }
```

**Idempotent create** (safe to retry):
```ts
await osr.sandboxes.create({ requiredCapabilities: ["filesystem"], idempotencyKey: "job-42" });
```

**Long-lived, reusable workspace** (get-or-create by name):
```ts
const sbx = await osr.sandboxes.create({ name: "agent-42-workspace", template: "python-3.12" });
// safe to call again later, from anywhere — reconnects instead of re-provisioning
```

**Checkpoint before a risky step, roll back on failure:**
```ts
const snap = await sbx.snapshot();
try {
  await sbx.run("python", ["risky_migration.py"]);
} catch {
  const clone = await osr.sandboxes.restore(snap, { requiredCapabilities: ["filesystem"] });
  // continue from `clone`, which has the pre-risky-step state
}
```
