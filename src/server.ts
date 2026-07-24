import Fastify, { type FastifyInstance } from "fastify";
import Tinypool from "tinypool";
import { availableParallelism } from "os";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import type { ParsedMatch } from "./types.ts";

const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

const MAX_BODY = 2 * 1024 * 1024;

type Runner = (logText: string) => Promise<ParsedMatch> | ParsedMatch;

export function buildApp(customRunner?: Runner): FastifyInstance {
  let run: Runner;

  if (customRunner) {
    run = customRunner;
  } else {
    const pool = new Tinypool({
      filename: fileURLToPath(new URL("./worker.ts", import.meta.url)),
      minThreads: 0,
      maxThreads: availableParallelism(),
      idleTimeout: 500,
    });

    const app = Fastify({ logger: false, bodyLimit: MAX_BODY });
    app.addHook("onClose", async () => {
      await pool.destroy();
    });

    run = (body) => pool.run(body) as Promise<ParsedMatch>;

    return attachRoutes(app, run);
  }

  const app = Fastify({ logger: false, bodyLimit: MAX_BODY });
  return attachRoutes(app, run);
}

function attachRoutes(app: FastifyInstance, run: Runner): FastifyInstance {
  app.addContentTypeParser(
    ["text/plain", "application/octet-stream"],
    { parseAs: "string", bodyLimit: MAX_BODY },
    (_req, body, done) => done(null, body)
  );

  app.setErrorHandler((err: { statusCode?: number; message?: string }, _request, reply) => {
    if (err.statusCode === 413) {
      return reply.code(413).send({ error: "log too large" });
    }
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
    } catch {
      return reply.code(500).send({ error: "internal parse error" });
    }
  });

  app.get("/", (_request, reply) => {
    return reply.type("text/html").send(UI_HTML);
  });

  app.get("/health", async () => {
    return { ok: true };
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
}
