import { describe, it, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { buildApp } from "../src/server.ts";
import { parse } from "../src/parser.ts";
import type { ParsedMatch } from "../src/types.ts";

function fixture(name: string): string {
  return join(import.meta.dir, "fixtures", name);
}

describe("HTTP server", () => {
  const app = buildApp(parse);

  afterAll(async () => {
    await app.close();
  });

  describe("GET /health", () => {
    it("returns 200 with ok: true", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe("POST /parse", () => {
    it("parses 1v1-soldier log and matches golden fixture", async () => {
      const logText = readFileSync(fixture("1v1-soldier.log"), "utf8");
      const expected = JSON.parse(
        readFileSync(fixture("1v1-soldier.json"), "utf8")
      ) as ParsedMatch;

      const res = await app.inject({
        method: "POST",
        url: "/parse",
        headers: { "content-type": "text/plain" },
        body: logText,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expected);
    });

    it("returns 400 for empty body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/parse",
        headers: { "content-type": "text/plain" },
        body: "",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe("empty log");
    });

    it("returns 400 for body containing no meta_data line", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/parse",
        headers: { "content-type": "text/plain" },
        body: 'L 04/28/2026 - 05:12:41: some random line without meta\n',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe("missing meta_data");
    });

    it("returns 400 for whitespace-only body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/parse",
        headers: { "content-type": "text/plain" },
        body: "   \n   ",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe("empty log");
    });

    it("returns 413 for body exceeding 2 MB", async () => {
      const bigBody = "x".repeat(2 * 1024 * 1024 + 1);

      const res = await app.inject({
        method: "POST",
        url: "/parse",
        headers: { "content-type": "text/plain" },
        body: bigBody,
      });

      expect(res.statusCode).toBe(413);
      expect(res.json<{ error: string }>().error).toBe("log too large");
    });
  });
});

describe("HTTP server under concurrent load", () => {
  // Uses the real Tinypool worker pool (no customRunner), unlike the suite
  // above, to catch cross-request contamination bugs that only show up when
  // multiple worker threads run in parallel against shared route state.
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  const fixtureNames = [
    "1v1-soldier",
    "1v1-no-supstats2",
    "1v1-new-matchend",
    "1v1-aborted-disconnect",
    "1v1-aborted-map-change",
  ];

  it("resolves each of many parallel /parse requests with its own result", async () => {
    // Fire several rounds of every fixture concurrently so requests interleave
    // across worker threads, not just run one-at-a-time.
    const rounds = 4;
    const requests = Array.from({ length: rounds }, () => fixtureNames).flat();

    const responses = await Promise.all(
      requests.map(async (name) => {
        const logText = readFileSync(fixture(`${name}.log`), "utf8");
        const res = await app.inject({
          method: "POST",
          url: "/parse",
          headers: { "content-type": "text/plain" },
          body: logText,
        });
        return { name, res };
      })
    );

    for (const { name, res } of responses) {
      const expected = JSON.parse(readFileSync(fixture(`${name}.json`), "utf8")) as ParsedMatch;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expected);
    }
  });

  it("keeps /health responsive while the pool is busy", async () => {
    const logText = readFileSync(fixture("1v1-soldier.log"), "utf8");
    const parseRequests = Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "POST",
          url: "/parse",
          headers: { "content-type": "text/plain" },
          body: logText,
        })
      )
    );

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ ok: boolean }>().ok).toBe(true);

    await parseRequests;
  });
});
