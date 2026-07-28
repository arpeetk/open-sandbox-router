// Bundles the CLI (and its workspace deps @osr/sdk, @osr/core) into a single
// self-contained ESM file with a node shebang. The result runs on plain Node — no
// pnpm, no tsx, no workspace resolution required — so it can be linked globally.

import { build } from "esbuild";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "bin", "osr.mjs");

await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
});

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
