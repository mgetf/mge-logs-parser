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
