import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";

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
});
