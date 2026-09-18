import Fastify, { type FastifyInstance } from "fastify";
import Tinypool from "tinypool";
import { availableParallelism } from "os";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import type { ParsedMatch } from "./types.ts";

const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

const MAX_BODY = 2 * 1024 * 1024;

type Runner = (logText: string) => Promise<ParsedMatch> | ParsedMatch;

type PoolStats = { threads: number; queued: number };

// Errors Tinypool rejects with when the queue is full / all workers are busy.
// There is no exported error class to `instanceof` against, so we match on message.
const QUEUE_SATURATED_RE = /task queue|workers are busy/i;

export function buildApp(customRunner?: Runner): FastifyInstance {
  let run: Runner;

  if (customRunner) {
    run = customRunner;
  } else {
    const pool = new Tinypool({
      filename: fileURLToPath(new URL("./worker.ts", import.meta.url)),
      // Keep at least one warm worker instead of scaling to 0. Constantly
      // tearing down/recreating worker threads under bursty concurrent
      // traffic is what triggers Bun's worker_threads teardown race
      // (oven-sh/bun#41022, fixed in 1.4.x) — minimizing thread churn here
      // reduces exposure even on a patched runtime.
      minThreads: 1,
      maxThreads: availableParallelism(),
      idleTimeout: 30_000,
      // Bound the backlog instead of the default Infinity so a sustained
      // burst fails fast (503) instead of buffering an unbounded number of
      // full request bodies in memory while waiting for a free worker.
      maxQueue: "auto",
    });

    const app = Fastify({ logger: false, bodyLimit: MAX_BODY });
    app.addHook("onClose", async () => {
      await pool.destroy();
    });

    run = (body) => pool.run(body) as Promise<ParsedMatch>;

    return attachRoutes(app, run, () => ({
      threads: pool.threads.length,
      queued: pool.queueSize,
    }));
  }

  const app = Fastify({ logger: false, bodyLimit: MAX_BODY });
  return attachRoutes(app, run);
}

function attachRoutes(
  app: FastifyInstance,
  run: Runner,
  getPoolStats?: () => PoolStats
): FastifyInstance {
  app.addContentTypeParser(
    ["text/plain", "application/octet-stream"],
    { parseAs: "string", bodyLimit: MAX_BODY },
    (_req, body, done) => done(null, body)
  );

  app.setErrorHandler((err: { statusCode?: number; message?: string }, _request, reply) => {
    if (err.statusCode === 413) {
      return reply.code(413).send({ error: "log too large" });
    }
    console.error("[mge-logs-parser] unhandled request error:", err);
    return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "internal error" });
  });

  app.post("/parse", async (request, reply) => {
    const body = (request.body as string) ?? "";

    if (!body.trim()) {
      return reply.code(400).send({ error: "empty log" });
    }

    if (!body.includes('"meta_data"')) {
      return reply.code(400).send({ error: "missing meta_data" });
    }

    try {
      const result = await run(body);
      return reply.send(result);
    } catch (err) {
      if (err instanceof Error && QUEUE_SATURATED_RE.test(err.message)) {
        reply.header("retry-after", "1");
        return reply.code(503).send({ error: "server busy, retry" });
      }
      console.error("[mge-logs-parser] parse failed:", err);
      return reply.code(500).send({ error: "internal parse error" });
    }
  });

  app.get("/", (_request, reply) => {
    return reply.type("text/html").send(UI_HTML);
  });

  app.get("/health", async () => {
    if (!getPoolStats) return { ok: true };
    return { ok: true, pool: getPoolStats() };
  });

  return app;
}

if (import.meta.main) {
  const PORT = Number(process.env["PORT"] ?? 3000);
  console.log(`[mge-logs-parser] starting on port ${PORT}`);
  const app = buildApp();
  app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      console.error("[mge-logs-parser] failed to start:", err);
      process.exit(1);
    }
    console.log(`[mge-logs-parser] listening on port ${PORT}`);
  });

  // Let in-flight /parse requests finish (and the worker pool drain) before
  // the process exits, instead of Railway force-killing mid-request on every
  // redeploy. Without this, deploy frequency scaling up with traffic means
  // more dropped requests during rollouts.
  const shutdown = (signal: string) => {
    console.log(`[mge-logs-parser] received ${signal}, shutting down`);
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("[mge-logs-parser] error during shutdown:", err);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // The parser and its Tinypool workers hold no shared mutable state across
  // requests (see docs/spec.md §3), so one bad request cannot corrupt state
  // for the others in flight. Logging and surviving a stray JS-level
  // exception here is strictly better than the default crash-the-process
  // behavior. This does NOT catch native-level crashes (segfault/SIGABRT) —
  // those bypass the JS exception mechanism entirely; see docs/spec.md or the
  // Bun runtime version pin for that class of issue.
  process.on("uncaughtException", (err) => {
    console.error("[mge-logs-parser] uncaught exception (continuing):", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[mge-logs-parser] unhandled rejection (continuing):", reason);
  });
}
