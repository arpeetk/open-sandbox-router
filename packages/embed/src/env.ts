import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimal KEY=VALUE loader (no dependency). Existing env vars win. */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

/** Load .env.local then .env from a directory (defaults to cwd). */
export function loadEnvFiles(dir = process.cwd()): void {
  loadEnvFile(join(dir, ".env.local"));
  loadEnvFile(join(dir, ".env"));
}

/**
 * Where local-mode state (the sandbox->provider binding file) lives.
 * Override the directory with OSR_STATE_DIR; defaults to ~/.osr.
 */
export function defaultStatePath(): string {
  const dir = process.env.OSR_STATE_DIR ?? join(homedir(), ".osr");
  return join(dir, "bindings.json");
}
