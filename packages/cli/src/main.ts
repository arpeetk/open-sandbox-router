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
import { buildEmbeddedService, FileBindingStore, loadEnvFiles, defaultStatePath } from "@osr/embed";

/** Flags that never take a value (so `osr --local providers` parses correctly). */
const BOOLEAN_FLAGS = new Set(["local", "version", "help"]);

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

async function main(): Promise<void> {
  const { _, flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = _[0];

  if (flags.version || cmd === "version") {
    console.log(`osr ${VERSION}`);
    return;
  }

  const tenant = typeof flags.tenant === "string" ? flags.tenant : (process.env.OSR_TENANT ?? "default");
  const local = Boolean(flags.local) || process.env.OSR_LOCAL === "1" || process.env.OSR_MODE === "local";

  let client: OSR;
  if (local) {
    // Embed the router in-process — no gateway needed. Bindings persist to disk so
    // session affinity survives across separate CLI invocations. Real providers (via
    // OSR_<PROVIDER>_REAL=1 in your env/.env.local) reconnect by their remote id.
    loadEnvFiles();
    const { service, registry } = buildEmbeddedService({
      bindings: new FileBindingStore(defaultStatePath()),
    });
    client = new OSR({ ops: new LocalOps({ service, registry, tenant }) });
  } else {
    client = new OSR({
      baseUrl: typeof flags.url === "string" ? flags.url : process.env.OSR_URL,
      tenant,
    });
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
          "",
          "modes:  default talks to a gateway (OSR_URL); --local embeds the router",
          "        in-process (no gateway) and persists state to ~/.osr/bindings.json",
          "",
          "flags: --local --template --name <n> --require <cap> --prefer <cap> --strategy <s>",
          "       --region <r> --isolation <lvl> --max-cost <usd> --order <p> --vcpu --memory",
          "       --from-snapshot <provider>:<id> --url --tenant",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
