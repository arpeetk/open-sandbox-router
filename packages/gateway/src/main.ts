import { buildServer } from "./server.js";
import { buildContext } from "./config.js";
import { startReaper } from "./reaper.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const reapIntervalMs = Number(process.env.OSR_REAP_INTERVAL_MS ?? 60_000);

const ctx = buildContext();
const app = buildServer(ctx);

if (reapIntervalMs > 0) {
  startReaper(ctx.service, reapIntervalMs);
}

app
  .listen({ port, host })
  .then((addr) => {
    // eslint-disable-next-line no-console
    console.log(`[osr] gateway listening on ${addr}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
