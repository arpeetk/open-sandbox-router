/**
 * A tiny in-memory sandbox runtime. It is NOT a real isolation boundary — it exists so
 * the demo, tests, and provider stubs can exercise the full create/exec/fs/runCode path
 * without external services. Real adapters replace this with provider API calls.
 */

import type { CodeEvent, ExecEvent, ExecRequest, FileEntry } from "@osr/core";

interface SimSandbox {
  ref: string;
  files: Map<string, Uint8Array>;
  createdAt: number;
}

const td = new TextDecoder();
const te = new TextEncoder();

export class SimulatedRuntime {
  private readonly sandboxes = new Map<string, SimSandbox>();
  private seq = 0;

  constructor(private readonly providerId: string) {}

  create(): string {
    const ref = `${this.providerId}-sim-${++this.seq}`;
    this.sandboxes.set(ref, { ref, files: new Map(), createdAt: Date.now() });
    return ref;
  }

  destroy(ref: string): void {
    this.sandboxes.delete(ref);
  }

  exists(ref: string): boolean {
    return this.sandboxes.has(ref);
  }

  private box(ref: string): SimSandbox {
    const b = this.sandboxes.get(ref);
    if (!b) throw new Error(`sim sandbox ${ref} not found`);
    return b;
  }

  writeFile(ref: string, path: string, data: Uint8Array): void {
    this.box(ref).files.set(normalize(path), data);
  }

  readFile(ref: string, path: string): Uint8Array {
    const f = this.box(ref).files.get(normalize(path));
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f;
  }

  removeFile(ref: string, path: string): void {
    this.box(ref).files.delete(normalize(path));
  }

  listFiles(ref: string, path: string): FileEntry[] {
    const prefix = normalize(path).replace(/\/?$/, "/");
    const entries: FileEntry[] = [];
    for (const [p, data] of this.box(ref).files) {
      if (p.startsWith(prefix)) {
        entries.push({ path: p, type: "file", sizeBytes: data.byteLength });
      }
    }
    return entries;
  }

  async *exec(ref: string, req: ExecRequest): AsyncIterable<ExecEvent> {
    const box = this.box(ref);
    const argv = [req.cmd, ...(req.args ?? [])];
    const line = argv.join(" ");

    if (argv[0] === "echo") {
      yield { type: "stdout", data: argv.slice(1).join(" ") + "\n" };
      yield { type: "exit", code: 0 };
      return;
    }
    if (argv[0] === "cat" && argv[1]) {
      const f = box.files.get(normalize(argv[1]));
      if (!f) {
        yield { type: "stderr", data: `cat: ${argv[1]}: No such file\n` };
        yield { type: "exit", code: 1 };
        return;
      }
      yield { type: "stdout", data: td.decode(f) };
      yield { type: "exit", code: 0 };
      return;
    }
    if (argv[0] === "ls") {
      const names = [...box.files.keys()].join("\n");
      yield { type: "stdout", data: names + (names ? "\n" : "") };
      yield { type: "exit", code: 0 };
      return;
    }

    yield { type: "stdout", data: `[${this.providerId} sim] ran: ${line}\n` };
    yield { type: "exit", code: 0 };
  }

  async *runCode(ref: string, code: string): AsyncIterable<CodeEvent> {
    this.box(ref); // ensure exists
    // Extremely small "interpreter": echoes prints and returns the last expression.
    const printed: string[] = [];
    for (const m of code.matchAll(/print\((.*?)\)/g)) {
      printed.push(stripQuotes(m[1] ?? ""));
    }
    if (printed.length) yield { type: "stdout", data: printed.join("\n") + "\n" };
    yield { type: "result", mime: "text/plain", data: `[${this.providerId} sim] executed ${code.length} chars` };
    yield { type: "done" };
  }

  static encode(s: string): Uint8Array {
    return te.encode(s);
  }
}

function normalize(p: string): string {
  return p.startsWith("/") ? p : "/" + p;
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, "");
}
