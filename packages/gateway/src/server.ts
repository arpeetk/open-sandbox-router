import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { isOsrError, type CodeEvent, type CreateSandboxRequest, type ExecEvent } from "@osr/core";
import { buildContext, resolveTenant, type AppContext } from "./config.js";

const td = new TextDecoder();
const te = new TextEncoder();

/** Stream an async iterable of JSON events to the client as Server-Sent Events. */
async function streamSse(
  reply: FastifyReply,
  events: AsyncIterable<ExecEvent | CodeEvent>,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  try {
    for await (const ev of events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch (err) {
    const body = isOsrError(err) ? err.toJSON() : { error: { code: "Internal", message: String(err) } };
    res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
  } finally {
    res.end();
  }
}

export function buildServer(ctx: AppContext = buildContext()): FastifyInstance {
  const app = Fastify({ logger: false });
  const { service, registry, meter } = ctx;

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (isOsrError(err)) return reply.status(err.httpStatus).send(err.toJSON());
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: { code: "Internal", message } });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Provider catalog + live health.
  app.get("/v1/providers", async () =>
    registry.manifests().map((m) => ({ ...m, health: registry.healthOf(m.provider) })),
  );

  // Dry-run routing: see where a request WOULD be placed and why.
  app.post("/v1/route/plan", async (req) => service.planRoute(req.body as CreateSandboxRequest));

  // Create (the only routing decision point).
  app.post("/v1/sandboxes", async (req, reply) => {
    const tenant = resolveTenant(req.headers as Record<string, unknown>);
    const outcome = await service.create(req.body as CreateSandboxRequest, { tenant });
    return reply.status(201).send(outcome);
  });

  app.get("/v1/sandboxes", async (req) => {
    const tenant = resolveTenant(req.headers as Record<string, unknown>);
    return service.list(tenant);
  });

  app.get("/v1/sandboxes/:id", async (req) => {
    const { id } = req.params as { id: string };
    return service.get(id);
  });

  app.delete("/v1/sandboxes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await service.destroy(id);
    return reply.status(204).send();
  });

  app.post("/v1/sandboxes/:id/exec", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { cmd: string; args?: string[]; cwd?: string; timeoutSeconds?: number };
    await streamSse(reply, service.exec(id, body));
  });

  app.post("/v1/sandboxes/:id/runCode", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { session: string; code: string; language?: string };
    await streamSse(reply, service.runCode(id, body));
  });

  app.post("/v1/sandboxes/:id/fs/write", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { path: string; content: string };
    await service.fsWrite(id, body.path, te.encode(body.content));
    return reply.status(204).send();
  });

  app.get("/v1/sandboxes/:id/fs/read", async (req) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path: string };
    const data = await service.fsRead(id, path);
    return { path, content: td.decode(data) };
  });

  app.get("/v1/sandboxes/:id/fs/list", async (req) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path: string };
    return service.fsList(id, path ?? "/");
  });

  app.post("/v1/sandboxes/:id/ports", async (req) => {
    const { id } = req.params as { id: string };
    const { port } = req.body as { port: number };
    return service.exposePort(id, port);
  });

  app.post("/v1/sandboxes/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    return service.pause(id);
  });

  app.post("/v1/sandboxes/:id/resume", async (req) => {
    const { id } = req.params as { id: string };
    return service.resume(id);
  });

  app.post("/v1/sandboxes/:id/snapshot", async (req) => {
    const { id } = req.params as { id: string };
    return service.snapshot(id);
  });

  // Usage / metering summary.
  app.get("/v1/usage", async () => ({ summary: meter.summary(), records: meter.all() }));

  return app;
}
