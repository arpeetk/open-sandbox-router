/**
 * `osr` — a thin CLI over the OSR gateway. Talks to the same REST API the SDK uses.
 *
 *   osr providers                            list registered providers + capabilities
 *   osr plan --require runCode --strategy cost   dry-run routing for a create request
 *   osr create --template python-3.12 --require runCode
 *   osr ls
 *   osr exec <id> -- python -c "print(1+1)"
 *   osr rm <id>
 */

import type { CapabilityName, CreateSandboxRequest } from "@osr/core";
import { OSR } from "@osr/sdk";

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

  return {
    template: typeof flags.template === "string" ? flags.template : undefined,
    requiredCapabilities: asArray(flags.require) as CapabilityName[],
    preferredCapabilities: asArray(flags.prefer) as CapabilityName[],
    resources: {
      vcpu: flags.vcpu ? Number(flags.vcpu) : undefined,
      memoryMB: flags.memory ? Number(flags.memory) : undefined,
    },
    routing,
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

  const client = new OSR({
    baseUrl: typeof flags.url === "string" ? flags.url : process.env.OSR_URL,
    tenant: typeof flags.tenant === "string" ? flags.tenant : process.env.OSR_TENANT,
  });

  switch (cmd) {
    case "providers": {
      const providers = await client.providers();
      for (const p of providers) {
        const feats = Object.entries(p.features)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(",");
        console.log(`${p.provider.padEnd(12)} ${p.isolation.padEnd(9)} ~${p.coldStartMsP50}ms  [${feats}]`);
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
      console.log(`created ${sbx.id} on ${sbx.provider} (caps: ${sbx.capabilities.join(", ")})`);
      if (sbx.attempts.length > 1) {
        console.log(`  failover path: ${sbx.attempts.map((a) => a.provider).join(" -> ")}`);
      }
      break;
    }
    case "ls": {
      const list = await client.sandboxes.list();
      for (const s of list) console.log(`${s.id}  ${s.provider.padEnd(12)} ${s.status}`);
      break;
    }
    case "exec": {
      const id = _[1];
      if (!id || rest.length === 0) throw new Error("usage: osr exec <id> -- <cmd> [args...]");
      const sbx = await client.sandboxes.get(id);
      const res = await sbx.run(rest[0]!, rest.slice(1));
      process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.code;
      break;
    }
    case "rm": {
      const id = _[1];
      if (!id) throw new Error("usage: osr rm <id>");
      await (await client.sandboxes.get(id)).destroy();
      console.log(`destroyed ${id}`);
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
          "  exec <id> -- <cmd...>     run a command",
          "  rm <id>                   destroy a sandbox",
          "",
          "flags: --template --require <cap> --prefer <cap> --strategy <s> --region <r>",
          "       --isolation <lvl> --max-cost <usd> --order <p> --vcpu --memory --url --tenant",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
