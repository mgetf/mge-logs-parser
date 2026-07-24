# mge-logs-parser

A standalone HTTP microservice that parses raw TF2 match log files (as produced by the [`mge_logs`](https://github.com/mgetf/mge-logs) SourceMod plugin) into structured JSON. Built for [mge.tf](https://mge.tf), a competitive TF2 MGE duel league.

The parser is a pure function: same input text always produces the same output JSON. It performs no database writes and has no external runtime dependencies — any system that needs structured match data (the mge.tf website, historical re-processing, a future competitive plugin, etc.) can consume it independently of the rest of the mge.tf stack.

See [`docs/spec.md`](docs/spec.md) for the full specification, including the input log format, parsing rules, and output schema.

## Tech stack

- **Runtime:** [Bun](https://bun.com)
- **Language:** TypeScript (strict mode), executed natively by Bun
- **HTTP framework:** [Fastify](https://fastify.dev)
- **Worker pool:** [tinypool](https://github.com/tinylibs/tinypool) (parsing runs off the main event loop)
- **Tests:** Bun's built-in test runner (`bun test`)

## Getting started

Install dependencies:

```bash
bun install
```

Run the server:

```bash
bun run start
```

Run in watch mode:

```bash
bun run dev
```

Run the test suite:

```bash
bun run test
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP server listens on |

## HTTP API

### `POST /parse`

Accepts a raw TF2 log file as the request body (`Content-Type: text/plain`) and returns the parsed match as JSON.

```
POST /parse
Content-Type: text/plain

<raw log file content>
```

| Status | Meaning |
|---|---|
| `200` | Returns the parsed `ParsedMatch` JSON |
| `400` | Empty body, or no `meta_data` line found |
| `413` | Body exceeds 2 MB |
| `500` | Unhandled parse error |

### `GET /health`

Returns `{ "ok": true }`. Used for uptime/health checks.

### `GET /`

Serves a small HTML UI (`src/ui.html`) for pasting a log and viewing the parsed result manually.

Full request/response shapes are documented in [`docs/spec.md`](docs/spec.md#4-http-api).

## Security

**This service has no authentication.** It is designed to run on a private/internal network where the caller (the mge.tf backend) is the only client. If you deploy this service, put it behind a reverse proxy or network boundary that restricts access — do not expose `/parse` directly to the public internet. See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Sample data

- [`docs/example-logs/`](docs/example-logs/) contains real-shaped TF2 log files with all player identities, names, and IP addresses replaced by synthetic placeholders. They're useful for manually exercising the parser or the `/` UI.
- [`tests/fixtures/`](tests/fixtures/) contains the golden log/JSON pairs used by the test suite, also fully synthetic.

## Project structure

```
src/
  types.ts    — shared TypeScript interfaces (ParsedMatch, PlayerRecord, etc.)
  parser.ts   — pure synchronous parse function; no side effects, no runtime imports
  worker.ts   — worker thread entry point; wraps parser.ts for the tinypool pool
  server.ts   — Fastify HTTP server; dispatches parse calls to the worker pool
  ui.html     — minimal manual-testing UI served at GET /
docs/
  spec.md          — full parser specification (input format, rules, output schema)
  example-logs/     — sample synthetic log files
tests/
  fixtures/   — golden log/JSON pairs
  *.test.ts   — parser and HTTP server tests
```
