import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

/** Parse a `text/event-stream` body (as captured by Fastify's `inject()`) into events. */
function parseSse<T>(body: string): T[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim()) as T);
}

describe("gateway REST API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.OSR_PROVIDERS = "e2b,modal,vercel,kubernetes";
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("lists providers with capability manifests", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/providers" });
    expect(res.statusCode).toBe(200);
    const providers = res.json() as { provider: string }[];
    expect(providers.map((p) => p.provider).sort()).toEqual(["e2b", "kubernetes", "modal", "vercel"]);
  });

  it("creates, gets, and destroys a sandbox", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      payload: { template: "python-3.12", requiredCapabilities: ["filesystem"], routing: { strategy: "cost" } },
    });
    expect(create.statusCode).toBe(201);
    const { sandbox } = create.json() as { sandbox: { id: string; provider: string } };
    expect(sandbox.id).toMatch(/^sbx_/);

    const get = await app.inject({ method: "GET", url: `/v1/sandboxes/${sandbox.id}` });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { provider: string }).provider).toBe(sandbox.provider);

    const del = await app.inject({ method: "DELETE", url: `/v1/sandboxes/${sandbox.id}` });
    expect(del.statusCode).toBe(204);
  });

  it("returns a structured NoCompliantProvider error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/route/plan",
      payload: { requiredCapabilities: ["snapshot"], resources: { gpu: 8 }, routing: { isolationFloor: "microvm" } },
    });
    // gpu+snapshot+microvm is not jointly satisfiable by the stub providers.
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("NoCompliantProvider");
  });

  it("round-trips a file through the filesystem API", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      payload: { requiredCapabilities: ["filesystem"] },
    });
    const { sandbox } = create.json() as { sandbox: { id: string } };
    await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandbox.id}/fs/write`,
      payload: { path: "/work/hello.txt", content: "hi there" },
    });
    const read = await app.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandbox.id}/fs/read?path=/work/hello.txt`,
    });
    expect((read.json() as { content: string }).content).toBe("hi there");
  });

  it("streams exec output over SSE with stdout and a terminal exit event", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      payload: { requiredCapabilities: ["filesystem"], routing: { strategy: "pin:e2b" } },
    });
    const { sandbox } = create.json() as { sandbox: { id: string } };

    const exec = await app.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandbox.id}/exec`,
      payload: { cmd: "echo", args: ["hi", "from", "sse"] },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse<{ type: string; data?: string; code?: number }>(exec.body);
    expect(events.some((e) => e.type === "stdout" && e.data?.includes("hi from sse"))).toBe(true);
    expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
  });

  it("keeps independent sandboxes on their own bound provider across interleaved requests", async () => {
    // Real proof of session affinity over HTTP: two sandboxes pinned to two DIFFERENT
    // providers, with requests interleaved, must never cross-contaminate.
    const createA = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      payload: { requiredCapabilities: ["filesystem"], routing: { strategy: "pin:modal" } },
    });
    const createB = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      payload: { requiredCapabilities: ["filesystem"], routing: { strategy: "pin:vercel" } },
    });
    const a = (createA.json() as { sandbox: { id: string; provider: string } }).sandbox;
    const b = (createB.json() as { sandbox: { id: string; provider: string } }).sandbox;
    expect(a.provider).toBe("modal");
    expect(b.provider).toBe("vercel");

    // Interleave: touch B, then A, then B again, then A again.
    const getB1 = await app.inject({ method: "GET", url: `/v1/sandboxes/${b.id}` });
    const getA1 = await app.inject({ method: "GET", url: `/v1/sandboxes/${a.id}` });
    const getB2 = await app.inject({ method: "GET", url: `/v1/sandboxes/${b.id}` });
    const getA2 = await app.inject({ method: "GET", url: `/v1/sandboxes/${a.id}` });

    expect((getA1.json() as { provider: string }).provider).toBe("modal");
    expect((getA2.json() as { provider: string }).provider).toBe("modal");
    expect((getB1.json() as { provider: string }).provider).toBe("vercel");
    expect((getB2.json() as { provider: string }).provider).toBe("vercel");

    await app.inject({ method: "DELETE", url: `/v1/sandboxes/${a.id}` });
    await app.inject({ method: "DELETE", url: `/v1/sandboxes/${b.id}` });
  });
});
