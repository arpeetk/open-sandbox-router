/**
 * `osr` — a thin CLI over the OSR gateway (or embedded in-process via --local). Talks to
 * the same REST API the SDK uses.
 *
 *   osr providers                            list registered providers + capabilities
 *   osr plan --require runCode --strategy cost   dry-run routing for a create request
 *   osr create --template python-3.12 --require runCode
 *   osr create --name my-workspace --template node-20   # get-or-create by stable name
 *   osr ls
 *   osr exec <id> python -c "print(1+1)"     (no -- needed — "-c" is single-dash)
 *   osr exec <id> -- node --version          (-- needed: "--version" is a double-dash flag)
 *   osr pause <id>  /  osr resume <id>       (provider-dependent)
 *   osr snapshot <id>                        -> prints "<provider>:<snapshotId>"
 *   osr create --from-snapshot modal:im-abc123   restore a new sandbox from a snapshot
 *   osr rm <id>
 */

import type { CapabilityName, CreateSandboxRequest } from "@osr/core";
import { OSR, LocalOps } from "@osr/sdk";
import {
  buildEmbeddedService,
  FileBindingStore,
  FileCliConfig,
  loadEnvFiles,
  defaultStatePath,
  defaultConfigPath,
} from "@osr/embed";

/** Flags that never take a value (so `osr --local providers` parses correctly). */
const BOOLEAN_FLAGS = new Set(["local", "gateway", "version", "help"]);

const DEFAULT_GATEWAY_URL = "http://localhost:8080";
const PROBE_TIMEOUT_MS = 400;

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

function printHelp(): void {
  console.log(
    [
      "osr <command>",
      "  providers                 list providers + capabilities",
      "  plan     [flags]          dry-run routing",
      "  create   [flags]          create a sandbox",
      "  ls                        list sandboxes",
      "  exec <id> <cmd...>        run a command (add -- before it only if it has a --flag)",
      "  rm <id>                   destroy a sandbox",
      "  pause <id>                pause a sandbox (provider-dependent)",
      "  resume <id>               resume a paused sandbox",
      "  snapshot <id>             take a provider-native snapshot",
      "  config <command>          view/persist default mode, url, tenant — see `osr config`",
      "",
      "modes:  gateway (talks to a server at --url/OSR_URL) or local (embeds the router",
      "        in-process, persists state to ~/.osr/bindings.json). With nothing set at",
      "        all, the first run auto-detects and remembers its choice — no flag needed",
      "        after that. Force one persistently: `osr config set mode local`.",
      "",
      "flags: --local --gateway --template --name <n> --require <cap> --prefer <cap>",
      "       --strategy <s> --region <r> --isolation <lvl> --max-cost <usd> --order <p>",
      "       --vcpu --memory --from-snapshot <provider>:<id> --url --tenant",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const { _, flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = _[0];

  if (flags.version || cmd === "version") {
    console.log(`osr ${VERSION}`);
    return;
  }
  if (flags.help || !cmd) {
    printHelp();
    return;
  }

  const config = new FileCliConfig(defaultConfigPath());

  if (cmd === "config") {
    handleConfigCommand(_.slice(1), config);
    return;
  }

  const { tenant, url, mode } = await resolveSettings(flags, config);

  let client: OSR;
  if (mode === "local") {
    // Embed the router in-process — no gateway needed. Bindings persist to disk so
    // session affinity survives across separate CLI invocations. Real providers (via
    // OSR_<PROVIDER>_REAL=1 in your env/.env.local) reconnect by their remote id.
    loadEnvFiles();
    const { service, registry } = buildEmbeddedService({
      bindings: new FileBindingStore(defaultStatePath()),
    });
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
      break;
    }
    case "ls": {
      const list = await client.sandboxes.list();
      for (const s of list) {
        const tag = s.simulated ? " [SIMULATED]" : "";
        console.log(`${s.id}  ${s.provider.padEnd(12)} ${s.status}${tag}`);
      }
      break;
    }
    case "exec": {
      const id = _[1];
      // `--` is only required when the command itself needs a `--foo` flag (which would
      // otherwise be swallowed as an osr flag) — for the common case, anything after the
      // id is the command, no separator needed: `osr exec <id> ls -la` just works.
      const cmdArgs = rest.length > 0 ? rest : _.slice(2);
      if (!id) {
        // The id is ALWAYS the first word after "exec" — even when using `--`, e.g.
        // `osr exec <id> -- node --version`. A bare `osr exec -- ls` or `osr exec ls`
        // (where "ls" gets consumed as the id, leaving no command) both land here.
        throw new Error(
          "usage: osr exec <id> <cmd> [args...]\n" +
            "  missing <id> — it must come right after \"exec\", before any command or --.\n" +
            "  run `osr ls` (or `osr --local ls`) to find a sandbox id.",
        );
      }
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
      const id = _[1];
      if (!id) throw new Error("usage: osr rm <id>");
      // Destroy directly rather than `(await client.sandboxes.get(id)).destroy()` — get()
      // deliberately still fails on a stranded binding (see docs/GUIDE.md's note on the
      // `simulated` flag), and rm must be able to clean those up, not just healthy ones.
      await client.ops.destroy(id);
      console.log(`destroyed ${id}`);
      break;
    }
    case "pause": {
      const id = _[1];
      if (!id) throw new Error("usage: osr pause <id>");
      const sbx = await client.sandboxes.get(id);
      const updated = await sbx.pause();
      console.log(`paused ${id} (status: ${updated.status})`);
      break;
    }
    case "resume": {
      const id = _[1];
      if (!id) throw new Error("usage: osr resume <id>");
      const sbx = await client.sandboxes.get(id);
      const updated = await sbx.resume();
      console.log(`resumed ${id} (status: ${updated.status})`);
      break;
    }
    case "snapshot": {
      const id = _[1];
      if (!id) throw new Error("usage: osr snapshot <id>");
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
