/**
 * Live end-to-end test against REAL Modal and Vercel infrastructure, through the full
 * OSR stack (router -> binding -> provider). For each provider with usable credentials it:
 *   creates a sandbox (pinned to that provider) -> runs a version command ->
 *   writes and reads a file -> destroys it.
 *
 * Credentials are read from the environment (or a git-ignored .env.local / .env at the
 * repo root). Modal may instead authenticate via ~/.modal.toml.
 *
 *   cp .env.example .env.local   # fill in your tokens
 *   pnpm demo:live
 *
 * Providers without credentials are skipped with a hint — nothing is provisioned for them.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  InMemoryBindingStore,
  ProviderRegistry,
  SandboxService,
  type CredentialProvider,
  type ExecEvent,
  type ProviderCreds,
} from "@osr/core";
import { createModalAdapter } from "@osr/adapter-modal";
import { createVercelAdapter } from "@osr/adapter-vercel";

// --- tiny .env loader (no dependency) -------------------------------------
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}
loadEnv(join(process.cwd(), ".env.local"));
loadEnv(join(process.cwd(), ".env"));

// --- credential resolution ------------------------------------------------
const modalEnv = {
  token_id: process.env.OSR_MODAL_TOKEN_ID,
  token_secret: process.env.OSR_MODAL_TOKEN_SECRET,
};
const vercel = {
  token: process.env.OSR_VERCEL_TOKEN,
  team_id: process.env.OSR_VERCEL_TEAM_ID,
  project_id: process.env.OSR_VERCEL_PROJECT_ID,
};

const hasModalToml = existsSync(join(homedir(), ".modal.toml"));
const runModal = Boolean((modalEnv.token_id && modalEnv.token_secret) || hasModalToml);
const runVercel = Boolean(vercel.token && vercel.team_id && vercel.project_id);

const CREDS: Record<string, ProviderCreds> = {
  modal: modalEnv.token_id && modalEnv.token_secret
    ? { token_id: modalEnv.token_id, token_secret: modalEnv.token_secret }
    : {}, // fall back to ~/.modal.toml
  vercel: runVercel ? { token: vercel.token!, team_id: vercel.team_id!, project_id: vercel.project_id! } : {},
};
const credentials: CredentialProvider = { async credentialsFor(_t, p) { return CREDS[p] ?? {}; } };

const registry = new ProviderRegistry();
registry.register(createModalAdapter({ real: true }));
registry.register(createVercelAdapter({ real: true }));
const svc = new SandboxService({ registry, bindings: new InMemoryBindingStore(), credentials });

async function collect(it: AsyncIterable<ExecEvent>) {
  let stdout = "", stderr = "", code = 0;
  for await (const ev of it) {
    if (ev.type === "stdout") stdout += ev.data;
    else if (ev.type === "stderr") stderr += ev.data;
    else if (ev.type === "exit") code = ev.code;
  }
  return { stdout, stderr, code };
}

async function testProvider(
  provider: string,
  template: string,
  cmd: string,
  args: string[],
  filePath: string,
) {
  console.log(`\n=== ${provider.toUpperCase()} (live) ===`);
  const t0 = Date.now();
  const { sandbox } = await svc.create(
    { template, requiredCapabilities: ["filesystem"], routing: { strategy: `pin:${provider}` as `pin:${string}` } },
    { tenant: "live-test" },
  );
  console.log(`  created ${sandbox.id} on "${sandbox.provider}"  (${Date.now() - t0}ms)`);

  const v = await collect(svc.exec(sandbox.id, { cmd, args }));
  console.log(`  exec ${cmd} ${args.join(" ")} -> ${JSON.stringify(v.stdout.trim())}`);

  await svc.fsWrite(sandbox.id, filePath, new TextEncoder().encode("hello from OSR"));
  const back = new TextDecoder().decode(await svc.fsRead(sandbox.id, filePath));
  console.log(`  fs write+read ${filePath} -> ${JSON.stringify(back)}`);

  await svc.destroy(sandbox.id);
  console.log(`  destroyed`);
}

async function main() {
  if (!runModal && !runVercel) {
    console.log("No credentials found. Copy .env.example to .env.local and fill it in,");
    console.log("or set up ~/.modal.toml. See docs/GUIDE.md §10.");
    return;
  }

  if (runModal) {
    try { await testProvider("modal", "python-3.12", "python", ["--version"], "/tmp/osr.txt"); }
    catch (e) { console.error("  MODAL FAILED:", (e as Error).message); process.exitCode = 1; }
  } else {
    console.log("\n(skipping Modal — set OSR_MODAL_TOKEN_ID/SECRET or configure ~/.modal.toml)");
  }

  if (runVercel) {
    try { await testProvider("vercel", "node-20", "node", ["--version"], "hello.txt"); }
    catch (e) { console.error("  VERCEL FAILED:", (e as Error).message); process.exitCode = 1; }
  } else {
    console.log("\n(skipping Vercel — set OSR_VERCEL_TOKEN, OSR_VERCEL_TEAM_ID, OSR_VERCEL_PROJECT_ID)");
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
