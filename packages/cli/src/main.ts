/**
 * `osr` — a thin CLI over the OSR gateway (or embedded in-process, once `osr config set
 * mode local` — see resolveSettings). Talks to the same REST API the SDK uses.
 *
 * A `create` becomes the "current" sandbox automatically, so every command below can
 * drop the id — pass one explicitly any time to override. Omitting the id ALWAYS needs
 * `--` before the command itself, even when that command has no double-dash flags of
 * its own — otherwise the first bare word after the command name is read as the id:
 *
 *   osr create --template python-3.12 --require runCode   # now current
 *   osr exec -- python -c "print(1+1)"        no id + -- -> targets the current sandbox
 *   osr exec sbx_abc123 python -c "print(1+1)"  explicit id -> no -- needed ("-c" is single-dash)
 *   osr exec -- node --version                 -- also needed here ("--version" is double-dash)
 *   osr pause  /  osr resume                 (provider-dependent)
 *   osr snapshot                             -> prints "<provider>:<snapshotId>"
 *   osr create --from-snapshot modal:im-abc123   restore into a new sandbox (also becomes current)
 *   osr rm                                   destroys the current sandbox (confirms first)
 *
 *   osr ls                                   * marks the current sandbox
 *   osr use <id>                              switch which sandbox is current
 *   osr create --name my-workspace --template node-20   # get-or-create by stable name
 *   osr config set mode local                 do this once instead of typing --local forever
 */

import type { CapabilityName, CreateSandboxRequest, SandboxService } from "@osr/core";
import { OSR, LocalOps } from "@osr/sdk";
import {
  buildEmbeddedService,
  FileBindingStore,
  FileCliConfig,
  loadEnvFiles,
  envFileStatus,
  defaultStatePath,
  defaultConfigPath,
} from "@osr/embed";

/** Flags that never take a value (so `osr --local providers` parses correctly). */
const BOOLEAN_FLAGS = new Set(["local", "gateway", "version", "help", "yes"]);

const DEFAULT_GATEWAY_URL = "http://localhost:8080";
const PROBE_TIMEOUT_MS = 400;

/** Accepted on every command, regardless of what it does. */
const GLOBAL_FLAGS = ["local", "gateway", "url", "tenant", "version", "help"];
/** Everything buildCreateRequest() reads — shared by `create` and `plan`. */
const CREATE_FLAGS = [
  "template",
  "name",
  "require",
  "prefer",
  "strategy",
  "region",
  "isolation",
  "max-cost",
  "order",
  "vcpu",
  "memory",
  "from-snapshot",
];
const COMMAND_FLAGS: Record<string, string[]> = { create: CREATE_FLAGS, plan: CREATE_FLAGS, rm: ["yes"] };

/** Every top-level command osr recognizes — checked before `resolveSettings()` runs so
 * a typo'd command doesn't pay for (or trigger) the gateway auto-detect probe, and can't
 * silently persist an "auto" mode decision to config for an invocation that did nothing. */
const KNOWN_COMMANDS = new Set([
  "providers",
  "plan",
  "create",
  "ls",
  "use",
  "doctor",
  "exec",
  "rm",
  "pause",
  "resume",
  "snapshot",
  "config",
]);

/** Standard edit-distance, for suggesting the likely-intended flag on a typo. */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

/**
 * A warning, never a hard failure — parseArgs is deliberately generic (exec's trailing
 * args legitimately contain flags OSR doesn't own), so an unrecognized --foo could be
 * a genuine typo or could be intentional passthrough. Print a best-effort suggestion
 * and let execution continue exactly as it already did.
 */
function warnUnknownFlags(flags: Parsed["flags"], cmd: string | undefined): void {
  const allowed = new Set([...GLOBAL_FLAGS, ...(cmd ? (COMMAND_FLAGS[cmd] ?? []) : [])]);
  for (const key of Object.keys(flags)) {
    if (allowed.has(key)) continue;
    let best: string | undefined;
    let bestDist = Infinity;
    for (const candidate of allowed) {
      const d = levenshtein(key, candidate);
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
    const context = cmd ? ` for "${cmd}"` : "";
    if (best && bestDist <= 3) {
      console.error(`note: --${key} is not a recognized flag${context} — did you mean --${best}?`);
    } else {
      console.error(`note: --${key} is not a recognized flag${context}`);
    }
  }
}

interface Parsed {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
  rest: string[];
}

function parseArgs(argv: string[]): Parsed {
  const _: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        // Support repeated flags (e.g. --require a --require b).
        if (key in flags) {
          const cur = flags[key];
          flags[key] = Array.isArray(cur) ? [...cur, next] : [String(cur), next];
        } else {
          flags[key] = next;
        }
        i++;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags, rest };
}

function asArray(v: string | boolean | string[] | undefined): string[] {
  if (v === undefined || typeof v === "boolean") return [];
  return Array.isArray(v) ? v : [v];
}

function buildCreateRequest(flags: Parsed["flags"]): CreateSandboxRequest {
  const routing: CreateSandboxRequest["routing"] = {};
  if (typeof flags.strategy === "string") routing.strategy = flags.strategy as never;
  if (typeof flags.region === "string") routing.region = flags.region;
  if (typeof flags.isolation === "string") routing.isolationFloor = flags.isolation as never;
  if (typeof flags["max-cost"] === "string") routing.maxCostPerHourUsd = Number(flags["max-cost"]);
  const order = asArray(flags.order);
  if (order.length) routing.order = order;

  let fromSnapshot: CreateSandboxRequest["fromSnapshot"];
  if (typeof flags["from-snapshot"] === "string") {
    const [provider, snapshotId] = flags["from-snapshot"].split(":");
    if (!provider || !snapshotId) {
      throw new Error(`--from-snapshot expects "<provider>:<snapshotId>", got "${flags["from-snapshot"]}"`);
    }
    fromSnapshot = { provider, snapshotId };
  }

  return {
    template: typeof flags.template === "string" ? flags.template : undefined,
    name: typeof flags.name === "string" ? flags.name : undefined,
    requiredCapabilities: asArray(flags.require) as CapabilityName[],
    preferredCapabilities: asArray(flags.prefer) as CapabilityName[],
    resources: {
      vcpu: flags.vcpu ? Number(flags.vcpu) : undefined,
      memoryMB: flags.memory ? Number(flags.memory) : undefined,
    },
    routing,
    fromSnapshot,
  };
}

const VERSION = "0.1.0";

interface Settings {
  tenant: string;
  url: string;
  mode: "local" | "gateway";
  modeSource: "explicit" | "auto";
}

/** Mode from a CLI flag or env var — the highest-precedence, always-explicit source. */
function explicitMode(flags: Parsed["flags"]): "local" | "gateway" | undefined {
  if (flags.local) return "local";
  if (flags.gateway) return "gateway";
  if (process.env.OSR_LOCAL === "1") return "local";
  if (process.env.OSR_MODE === "local") return "local";
  if (process.env.OSR_MODE === "gateway") return "gateway";
  return undefined;
}

/** Fast, short-timeout reachability check — used only when nothing else has decided
 * a mode, and only once (the result gets persisted so this never runs again). */
async function probeGateway(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve mode/url/tenant with precedence: CLI flag > env var > config file > built-in
 * default. If nothing at all has decided a mode, probe the gateway once and persist
 * whichever way it goes (`modeSource: "auto"`) so this never re-runs on a later
 * invocation — a cold gateway shouldn't tax every single command with a network probe.
 */
async function resolveSettings(flags: Parsed["flags"], config: FileCliConfig): Promise<Settings> {
  const cfg = config.read();
  const tenant =
    (typeof flags.tenant === "string" ? flags.tenant : undefined) ?? process.env.OSR_TENANT ?? cfg.tenant ?? "default";
  const url =
    (typeof flags.url === "string" ? flags.url : undefined) ?? process.env.OSR_URL ?? cfg.url ?? DEFAULT_GATEWAY_URL;

  const explicit = explicitMode(flags);
  if (explicit) return { tenant, url, mode: explicit, modeSource: "explicit" };
  if (cfg.mode) return { tenant, url, mode: cfg.mode, modeSource: cfg.modeSource ?? "explicit" };

  const reachable = await probeGateway(url);
  const mode: "local" | "gateway" = reachable ? "gateway" : "local";
  config.update({ mode, modeSource: "auto" });
  if (!reachable) {
    console.error(
      `(no gateway at ${url} — using local mode; run \`osr config set mode gateway\` to always use a gateway)`,
    );
  }
  return { tenant, url, mode, modeSource: "auto" };
}

const CONFIG_KEYS = ["mode", "url", "tenant"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

function handleConfigCommand(args: string[], config: FileCliConfig): void {
  const [sub, key, value] = args;

  const requireKey = (k: string | undefined): ConfigKey => {
    if (!k || !(CONFIG_KEYS as readonly string[]).includes(k)) {
      throw new Error(`unknown config key "${k ?? ""}" (expected one of: ${CONFIG_KEYS.join(", ")})`);
    }
    return k as ConfigKey;
  };

  switch (sub) {
    case "set": {
      const k = requireKey(key);
      if (value === undefined) throw new Error(`usage: osr config set ${k} <value>`);
      if (k === "mode") {
        if (value !== "local" && value !== "gateway") {
          throw new Error(`mode must be "local" or "gateway", got "${value}"`);
        }
        config.update({ mode: value, modeSource: "explicit" });
      } else if (k === "url") {
        config.update({ url: value });
      } else {
        config.update({ tenant: value });
      }
      console.log(`set ${k} = ${value}`);
      break;
    }
    case "get": {
      const cfg = config.read();
      if (key) {
        const k = requireKey(key);
        console.log(cfg[k] ?? "(unset)");
      } else {
        console.log(JSON.stringify(cfg, null, 2));
      }
      break;
    }
    case "unset": {
      const k = requireKey(key);
      config.unset(k);
      console.log(`unset ${k}`);
      break;
    }
    default:
      console.log(
        [
          "osr config <command>",
          "  set <mode|url|tenant> <value>   persist a default (e.g. `osr config set mode local`)",
          "  get [key]                        show current config, or one key",
          "  unset <key>                      clear a key (unsetting mode re-enables auto-detect)",
          "",
          `config file: ${defaultConfigPath()}`,
        ].join("\n"),
      );
  }
}

/**
 * Reports resolved mode/tenant/url, env-file presence, per-provider simulated-vs-live
 * status with a BYOK hint, and (local mode only) any stranded bindings — surfaced
 * proactively via `SandboxService.strandedBindings()` rather than only discovered when
 * an operation on one happens to fail.
 */
async function handleDoctorCommand(opts: {
  mode: "local" | "gateway";
  modeSource: "explicit" | "auto";
  tenant: string;
  url: string;
  client: OSR;
  localInternals: { service: SandboxService } | undefined;
}): Promise<void> {
  const { mode, modeSource, tenant, url, client, localInternals } = opts;
  console.log(`mode:    ${mode}  (source: ${modeSource})`);
  console.log(`tenant:  ${tenant}`);
  console.log(`url:     ${url}${mode === "local" ? "  (unused in local mode)" : ""}`);

  if (mode === "local") {
    const files = envFileStatus();
    console.log("\nenv files:");
    console.log(`  .env.local   ${files.envLocal ? "found" : "not found"}`);
    console.log(`  .env         ${files.env ? "found" : "not found"}`);
  }

  console.log("\nproviders:");
  for (const p of await client.providers()) {
    const status = p.simulated ? "[SIMULATED]" : "live       ";
    let hint = "";
    if (mode === "local") {
      // Most providers' env-var prefix is just their id uppercased (matches
      // EnvCredentialProvider's generic BYOK scan in @osr/embed), but Kubernetes
      // uses the abbreviated OSR_K8S_* (see packages/embed/src/registry.ts) —
      // override it here rather than report a variable name that does nothing.
      const prefix = p.provider === "kubernetes" ? "OSR_K8S_" : `OSR_${p.provider.toUpperCase()}_`;
      const keys = Object.keys(process.env).filter((k) => k.startsWith(prefix));
      const realFlagSet = process.env[`${prefix}REAL`] === "1";
      if (p.simulated && realFlagSet) {
        hint = "  (REAL=1 is set but still simulated — check credentials, or this provider has no live adapter yet)";
      } else if (p.simulated && keys.length > 0) {
        hint = `  (found ${keys.join(", ")} but not ${prefix}REAL=1)`;
      } else if (p.simulated) {
        hint = `  (set ${prefix}REAL=1 + credentials to go live)`;
      } else {
        hint = keys.length > 0 ? `  (${keys.join(", ")})` : `  (no ${prefix}* vars — using ambient/default credentials)`;
      }
    }
    console.log(`  ${p.provider.padEnd(12)} ${status}${hint}`);
  }

  if (mode === "local" && localInternals) {
    const stranded = await localInternals.service.strandedBindings(tenant);
    if (stranded.length > 0) {
      console.log("\nstranded bindings (unreachable — registry/credentials config changed since creation):");
      for (const { binding, reason } of stranded) {
        console.log(`  ${binding.sandboxId}  (${binding.provider}) — ${reason}. Run \`osr rm ${binding.sandboxId}\` to clean up.`);
      }
    } else {
      console.log("\nstranded bindings: none");
    }
  } else if (mode === "gateway") {
    console.log("\n(env files, credential presence, and stranded-binding checks are local-mode only)");
  }
}

/**
 * Resolve the target sandbox id for exec/rm/pause/resume/snapshot: an explicit id
 * always wins, otherwise fall back to the current sandbox set via `osr use`/`create`.
 * Reports whether the id came from that fallback — `rm` uses it to decide whether to
 * confirm before destroying an implicit target instead of one the caller actually typed.
 */
function requireId(
  explicitId: string | undefined,
  config: FileCliConfig,
  tenant: string,
  usage: string,
): { id: string; fromCurrent: boolean } {
  if (explicitId) return { id: explicitId, fromCurrent: false };
  const current = config.currentSandbox(tenant);
  if (!current) throw new Error(usage);
  return { id: current, fromCurrent: true };
}

/**
 * y/N prompt before destroying a sandbox the caller didn't name explicitly — the
 * "current" sandbox is easy to lose track of across shells/sessions, so silently
 * destroying whatever it happens to point at is a footgun. Refuses outright (rather
 * than guessing) when stdin isn't a TTY; pass --yes to skip this in scripts.
 */
async function confirmDestroy(id: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      `refusing to destroy the current sandbox (${id}) without confirmation in a non-interactive shell — pass --yes or an explicit id to skip this`,
    );
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`destroy current sandbox ${id}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printHelp(): void {
  console.log(
    [
      "osr <command>",
      "  providers                 list providers + capabilities",
      "  plan     [flags]          dry-run routing",
      "  create   [flags]          create a sandbox (becomes the current one — see `use`)",
      "  ls                        list sandboxes (* marks the current one)",
      "  use [id]                  set (or show) the current sandbox for the commands below",
      "  exec [id] <cmd...>        run a command — id defaults to the current sandbox",
      "  rm [id]                   destroy a sandbox — confirms first when falling back to",
      "                            the current sandbox (skip with --yes, or pass an id)",
      "  pause [id]                pause a sandbox (provider-dependent)",
      "  resume [id]               resume a paused sandbox",
      "  snapshot [id]             take a provider-native snapshot",
      "  config <command>          view/persist default mode, url, tenant — see `osr config`",
      "  doctor                    diagnose mode/credentials/provider setup",
      "",
      "Any [id] above can be omitted once `osr use <id>` (or a prior `osr create`) has set",
      "a current sandbox — it's always overridable by passing an explicit id instead. For",
      "`exec`, omitting the id ALSO requires `--` before the command itself, e.g.",
      "`osr exec -- ls -la` — without it, the first word after `exec` is read as the id",
      "(so `osr exec ls` tries to look up a sandbox literally named \"ls\").",
      "",
      "modes:  gateway (talks to a server at --url/OSR_URL) or local (embeds the router",
      "        in-process, persists state to ~/.osr/bindings.json). With nothing set at",
      "        all, the first run auto-detects and remembers its choice — no flag needed",
      "        after that. Force one persistently: `osr config set mode local`.",
      "",
      "flags: --local --gateway --template --name <n> --require <cap> --prefer <cap>",
      "       --strategy <s> --region <r> --isolation <lvl> --max-cost <usd> --order <p>",
      "       --vcpu --memory --from-snapshot <provider>:<id> --url --tenant --yes",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const { _, flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  warnUnknownFlags(flags, cmd);

  if (flags.version || cmd === "version") {
    console.log(`osr ${VERSION}`);
    return;
  }
  if (flags.help || !cmd) {
    printHelp();
    return;
  }
  if (!KNOWN_COMMANDS.has(cmd)) {
    console.error(`osr: unknown command "${cmd}"`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const config = new FileCliConfig(defaultConfigPath());

  if (cmd === "config") {
    handleConfigCommand(_.slice(1), config);
    return;
  }

  const { tenant, url, mode, modeSource } = await resolveSettings(flags, config);

  let client: OSR;
  // Only populated in local mode — doctor uses this for the stranded-binding check,
  // which has no equivalent gateway REST endpoint to ask for remotely.
  let localInternals: { service: SandboxService } | undefined;
  if (mode === "local") {
    // Embed the router in-process — no gateway needed. Bindings persist to disk so
    // session affinity survives across separate CLI invocations. Real providers (via
    // OSR_<PROVIDER>_REAL=1 in your env/.env.local) reconnect by their remote id.
    loadEnvFiles();
    const { service, registry } = buildEmbeddedService({
      bindings: new FileBindingStore(defaultStatePath()),
    });
    localInternals = { service };
    client = new OSR({ ops: new LocalOps({ service, registry, tenant }) });
  } else {
    client = new OSR({ baseUrl: url, tenant });
  }

  switch (cmd) {
    case "providers": {
      const providers = await client.providers();
      for (const p of providers) {
        const feats = Object.entries(p.features)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(",");
        const tag = p.simulated ? " [SIMULATED]" : "";
        console.log(`${p.provider.padEnd(12)} ${p.isolation.padEnd(9)} ~${p.coldStartMsP50}ms  [${feats}]${tag}`);
      }
      break;
    }
    case "plan": {
      const plan = await client.routePlan(buildCreateRequest(flags));
      console.log(JSON.stringify(plan, null, 2));
      break;
    }
    case "create": {
      const sbx = await client.sandboxes.create(buildCreateRequest(flags));
      const tag = sbx.sandbox.simulated ? " [SIMULATED — never touched the real provider]" : "";
      console.log(`created ${sbx.id} on ${sbx.provider}${tag} (caps: ${sbx.capabilities.join(", ")})`);
      if (sbx.attempts.length > 1) {
        console.log(`  failover path: ${sbx.attempts.map((a) => a.provider).join(" -> ")}`);
      }
      // The sandbox you just made is almost always the one you want next — become
      // "current" so exec/rm/pause/etc. don't need the id repeated. Still fully
      // overridable: an explicit id on any later command always wins.
      config.setCurrentSandbox(tenant, sbx.id);
      break;
    }
    case "ls": {
      const list = await client.sandboxes.list();
      const current = config.currentSandbox(tenant);
      for (const s of list) {
        const tag = s.simulated ? " [SIMULATED]" : "";
        const marker = s.id === current ? "* " : "  ";
        console.log(`${marker}${s.id}  ${s.provider.padEnd(12)} ${s.status}${tag}`);
      }
      break;
    }
    case "use": {
      const id = _[1];
      if (!id) {
        const current = config.currentSandbox(tenant);
        console.log(current ?? "no current sandbox set — usage: osr use <id>");
        break;
      }
      await client.sandboxes.get(id); // fail fast on a typo before persisting
      config.setCurrentSandbox(tenant, id);
      console.log(`using ${id}`);
      break;
    }
    case "doctor": {
      await handleDoctorCommand({ mode, modeSource, tenant, url, client, localInternals });
      break;
    }
    case "exec": {
      // `--` is only required when the command itself needs a `--foo` flag (which would
      // otherwise be swallowed as an osr flag) — for the common case, anything after the
      // id is the command, no separator needed: `osr exec <id> ls -la` just works.
      // It's ALSO how you target the current sandbox with no id at all: `osr exec --
      // ls` (id omitted, `--` used) falls back to `osr use`'s current sandbox. A bare
      // `osr exec ls` (no --) still treats "ls" as the id, unchanged — deliberately not
      // reinterpreted, so an existing typo doesn't silently start hitting a different
      // sandbox than before.
      const cmdArgs = rest.length > 0 ? rest : _.slice(2);
      const { id } = requireId(
        _[1],
        config,
        tenant,
        "usage: osr exec <id> <cmd> [args...]  (or: osr exec -- <cmd> [args...] to use the current sandbox)\n" +
          "  no id given and no current sandbox set.\n" +
          "  run `osr ls` to find one, or `osr use <id>` first.",
      );
      if (cmdArgs.length === 0) {
        throw new Error(`usage: osr exec ${id} <cmd> [args...] — missing <cmd> to run`);
      }
      const sbx = await client.sandboxes.get(id);
      const res = await sbx.run(cmdArgs[0]!, cmdArgs.slice(1));
      process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.code;
      break;
    }
    case "rm": {
      const { id, fromCurrent } = requireId(
        _[1],
        config,
        tenant,
        "usage: osr rm <id>  (or set one first with `osr use <id>`)",
      );
      if (fromCurrent && !flags.yes) {
        const ok = await confirmDestroy(id);
        if (!ok) {
          console.log("aborted — pass an explicit id, or --yes, to skip this confirmation");
          break;
        }
      }
      // Destroy directly rather than `(await client.sandboxes.get(id)).destroy()` — get()
      // deliberately still fails on a stranded binding (see docs/GUIDE.md's note on the
      // `simulated` flag), and rm must be able to clean those up, not just healthy ones.
      await client.ops.destroy(id);
      console.log(`destroyed ${id}`);
      // Don't leave "current" pointing at a sandbox that no longer exists.
      if (config.currentSandbox(tenant) === id) config.clearCurrentSandbox(tenant);
      break;
    }
    case "pause": {
      const { id } = requireId(_[1], config, tenant, "usage: osr pause <id>  (or set one first with `osr use <id>`)");
      const sbx = await client.sandboxes.get(id);
      const updated = await sbx.pause();
      console.log(`paused ${id} (status: ${updated.status})`);
      break;
    }
    case "resume": {
      const { id } = requireId(_[1], config, tenant, "usage: osr resume <id>  (or set one first with `osr use <id>`)");
      const sbx = await client.sandboxes.get(id);
      const updated = await sbx.resume();
      console.log(`resumed ${id} (status: ${updated.status})`);
      break;
    }
    case "snapshot": {
      const { id } = requireId(
        _[1],
        config,
        tenant,
        "usage: osr snapshot <id>  (or set one first with `osr use <id>`)",
      );
      const sbx = await client.sandboxes.get(id);
      const snap = await sbx.snapshot();
      console.log(`${snap.provider}:${snap.snapshotId}`);
      console.log(`restore with: osr create --from-snapshot ${snap.provider}:${snap.snapshotId}`);
      break;
    }
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
