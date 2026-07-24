# MGE Logs Parser — Development Plan

**Status:** Draft  
**Created:** 2026-04-28

Each phase ends with a passing test suite and a working, shippable increment. No phase breaks a previous one. The spec (`docs/spec.md`) is the contract — when spec and plan disagree, the spec wins.

---

## Phase 1 — Project Scaffold

**Goal:** A runnable Bun/TypeScript project with the correct folder structure, dependencies, and an empty passing test suite.

### Tasks

- Initialise `package.json` with `type: "module"` via `bun init`
- Install runtime dependencies: `fastify`, `tinypool`
- Install dev dependencies: `typescript`, `@types/bun`
- Create `tsconfig.json` (strict mode, `Bundler` module resolution for Bun compatibility)
- Create the four source files as empty stubs: `src/types.ts`, `src/parser.ts`, `src/worker.ts`, `src/server.ts`
- Create `tests/` directory
- Add scripts to `package.json`: `start`, `dev`, `test`
  - `"test": "bun test"` — uses Bun's built-in runner
  - `"dev": "bun run --hot src/server.ts"`
  - `"start": "bun run src/server.ts"`
- Confirm `bun test` runs and reports 0 tests, 0 failures

### Done when

`bun test` exits 0. `bun run dev` starts without crashing (even with stub implementations).

---

## Phase 2 — Types and First Fixture

**Goal:** All shared TypeScript interfaces defined. First real log file ingested as a fixture with a failing test that will pass once the parser is built.

### Tasks

- Populate `src/types.ts` with the full `ParsedMatch` schema from the spec (§7)
- Copy `docs/example-logs/mge_260428051241f6e8.log` to `tests/fixtures/1v1-soldier.log`
- Create `tests/fixtures/1v1-soldier.json` manually — a hand-authored `ParsedMatch` JSON for this log (the golden output)
- Write `tests/parse.test.ts` using `import { test, expect } from "bun:test"` with a single test: read `1v1-soldier.log`, call `parse()`, deep-equal assert against `1v1-soldier.json`
- The test should **fail** at this point (parser is a stub returning `{}`)

### Notes on the fixture JSON

The `1v1-soldier.log` fixture covers:
- Both players are soldiers, 1v1 MGE, Badlands Middle 1 arena
- supstats2 damage lines present (with and without `realdamage`)
- Airshots present (as `(airshot "1") (height "n")` on damage lines)
- `mge_elo_delta` lines present (ELO unchanged — both players at same rating)
- `mge_match_end` in the **old format** (winner only, no loser field) — parser must handle both old and new format

The `mge_match_end` loser field was added to the plugin after this log was produced. The parser must support both formats:
- Old: `(winner "...") (winner_score "...") (loser_score "...")`
- New: `(winner "...") (loser "...") (winner_score "...") (loser_score "...")`

When `loser` is absent, infer the loser as the player whose Steam ID is not the winner (works reliably for 1v1 since there are exactly two players identified from `changed role to`).

### Done when

`bun test` runs one test and it **fails** with a meaningful error (not a crash). Types compile without errors.

---

## Phase 3 — Parser Core: Identity and Match Result

**Goal:** Parser extracts match metadata, player identities, and the final result. The kill timeline and stats are empty — just enough to establish who played and who won.

### Tasks

- Implement the line prefix stripper: extract `timestamp` + `message` from `L mm/dd/yyyy - HH:MM:SS: <message>`
- Implement `meta_data` line handler: populate `meta.matchId`, `meta.map`, `meta.arena`, `meta.gamemode`, `meta.fragLimit`, `meta.format` (infer `'1v1'` vs `'2v2'` from player count after parsing)
- Implement `changed role to` handler: build `players[]` array entries with `steamId`, `name`, `team`, `startClass`
- Implement `mge_match_end` handler (both 1v1 formats + 2v2 format): set `won`, `score` on each player
- Implement `mge_elo_delta` handler: populate `elo.before`, `elo.after`, `elo.delta` per player
- Implement `mge_match_aborted` handler: set `meta.aborted = true`, `meta.abortReason`
- Set `meta.startedAt` from first line timestamp, `meta.endedAt` from `mge_match_end` (or last line)
- Compute `meta.durationSeconds`
- Return `events: []`, `chat: []`, `players[n].stats` as all-zero placeholders

### Done when

The fixture test passes for all `meta` and `players` fields (excluding `stats`). `events` and `chat` are empty arrays — the test should assert they are empty at this stage.

---

## Phase 4 — Kill Events

**Goal:** Kill timeline populated. Per-player kill and death counts correct.

### Tasks

- Implement kill line handler matching: `"Attacker..." killed "Victim..." with "<weapon>"`
- Extract: `attackerSteamId`, `victimSteamId`, `weapon`, `timestamp`
- Extract optional suffixes: `(customkill "headshot")` → `headshot: true`, `(airshot "1")` → `airshot: true`
- Append `KillEvent` to `events[]`
- Increment `stats.kills` for attacker, `stats.deaths` for victim
- Handle `weapon "world"` (environment kill — attacker and victim may be the same player for fall damage) — still emit the kill event
- Update fixture JSON: populate `events` with `KillEvent` entries, update `stats.kills` and `stats.deaths` for both players

### Done when

Fixture test passes for all `KillEvent` entries and kill/death counts.

---

## Phase 5 — Damage, DPM, and Accuracy

**Goal:** All damage lines parsed. Per-player damage totals, DPM, shot counts, and accuracy computed.

### Tasks

- Implement `triggered "damage"` line handler
- Extract: `attackerSteamId`, `victimSteamId`, `damage`, `realdamage` (default `0` if absent), `weapon`, `headshot` (default `false`), `airshot` (default `false`), `height` (ignored at this stage)
- Append `DamageEvent` to `events[]`
- Accumulate `stats.damageDone` and `stats.damageReceived`
- Implement `triggered "shot_fired"` and `triggered "shot_hit"` handlers
- Accumulate `stats.shotsFired` and `stats.shotsHit` per player
- After pass: compute `stats.dpm = damageDone / (durationSeconds / 60)`, `stats.accuracy = (shotsHit / shotsFired) * 100` (null if shotsFired === 0)
- Update fixture JSON with full damage stats

### Done when

Fixture test passes for all `DamageEvent` entries and all damage/accuracy stats for both players.

---

## Phase 6 — Airshots and Per-Weapon Breakdown

**Goal:** Airshot count per player correct. Weapon breakdown populated.

### Tasks

- Detect airshots from `DamageEvent` entries where `airshot === true`: increment `stats.airshots` for attacker
- Detect headshot kills from `KillEvent` entries where `headshot === true`: increment `stats.headshotKills`
- Build `stats.weaponBreakdown`: for each weapon, accumulate `kills`, `damage`, `shotsFired`, `shotsHit`
  - `kills` from `KillEvent` where `weapon === w`
  - `damage` from `DamageEvent` where `weapon === w`
  - `shotsFired`/`shotsHit` from shot events where `weapon === w`
- Note: `weapon` values in the real log may differ between kill and damage lines for the same hit (e.g. `"quake_rl"` vs `"tf_projectile_rocket"`) — group under the weapon name as it appears in each event type; do not attempt to normalise
- Update fixture JSON with `airshots`, `headshotKills`, `weaponBreakdown`

### Done when

Fixture test passes for all airshot counts, headshot kill counts, and weapon breakdown entries.

---

## Phase 7 — Spawn Tracking (Class Changes)

**Goal:** Post-spawn class changes reflected in player records.

### Tasks

- Implement `spawned as "<class>"` handler
- Track the most recent class per player in parse state
- The `startClass` on `PlayerRecord` remains the class from `changed role to` (first spawn)
- Add `currentClass` field to internal parse state only — the output `PlayerRecord` reflects `startClass` only (current spec does not expose class history; this is reserved for a future enhancement)
- Discard the line after tracking — no new output field added yet

### Notes

This phase primarily validates that `spawned as` lines do not confuse the parser (they are common and must be classified before falling through to the discard path). It lays groundwork for per-class stat breakdowns in the future.

### Done when

Fixture test still passes unchanged. Parser does not throw or misclassify spawn lines.

---

## Phase 8 — Chat

**Goal:** All `say` and `say_team` lines captured.

### Tasks

- Implement `say` and `say_team` handlers
- Extract: `steamId`, `timestamp`, `scope` (`'all'` | `'team'`), `message`
- Append to `chat[]`
- Add a fixture that includes chat lines (or extend `1v1-soldier.json` if the log has any — check whether the real log contains say lines)
- Update fixture JSON with `chat` entries

### Done when

Fixture test passes for `chat` array contents.

---

## Phase 9 — HTTP Service

**Goal:** The parser is accessible over HTTP as described in the spec. The pure `parse()` function is unchanged. A health check endpoint exists.

### Tasks

- Implement `src/worker.ts`: import `parse` from `parser.ts`; listen on `parentPort`; call `parse(data)`; post result back
- Implement `src/server.ts`:
  - Create a `tinypool` pool pointing at `worker.ts`, pool size = `os.availableParallelism()`
  - Register `POST /parse`: read raw text body (max 2 MB), call `pool.run(body)`, return JSON result
  - Register `GET /health`: return `{ ok: true }`
  - Return 400 for empty body or missing `meta_data`
  - Return 413 for body exceeding 2 MB
  - Return 500 on unhandled exceptions
- Add an HTTP integration test (`tests/server.test.ts`) using `bun:test`: start a Fastify test instance, POST the `1v1-soldier.log` content, assert the response matches `1v1-soldier.json`
- Add a test for `GET /health`
- Add a test for 400 on empty body

### Done when

All unit and integration tests pass. `bun run start` starts the server. A manual `curl -X POST --data-binary @tests/fixtures/1v1-soldier.log http://localhost:3000/parse` returns the correct JSON.

---

## Phase 10 — Hardening and Edge Cases

**Goal:** All edge cases from spec §8 handled and covered by fixture tests.

### Tasks, one fixture pair per case

| Fixture name | What it tests | Source |
|---|---|---|
| `1v1-aborted-map-change.log` + `.json` | `mge_match_aborted` with `reason "map_change"`; `meta.aborted: true`; partial stats from incomplete match | Copy `mge_260427233226c477_incomplete.log` |
| `1v1-aborted-disconnect.log` + `.json` | `mge_match_aborted` with `reason "player_disconnect"` | Hand-edited synthetic log |
| `1v1-no-supstats2.log` + `.json` | Vanilla kill lines only; all damage/accuracy stats are `0`; `events` has only `KillEvent` | Strip supstats2 lines from `mge_260428051241f6e8.log` |
| `1v1-new-matchend.log` + `.json` | `mge_match_end` with `(loser "...")` field; no inference needed | Collect once server runs updated plugin |

Additional hardening tasks (no new fixture required):
- Verify 413 is returned for a synthetic body > 2 MB in the integration test
- Verify unknown line types are silently skipped (inject a fake line into a fixture log)
- Verify the parser does not throw if `mge_elo_delta` is absent
- Verify `fraglimit "0"` is stored as `0` (not null or NaN) — seen in the real log

### Done when

All fixture tests pass. `npm test` is green across all phases.

---

## Fixture inventory (end state)

```
tests/
  fixtures/
    1v1-soldier.log             ← copy of docs/example-logs/mge_260428051241f6e8.log
    1v1-soldier.json            ← hand-authored golden output
    1v1-aborted-map-change.log  ← copy of docs/example-logs/mge_260427233226c477_incomplete.log
    1v1-aborted-map-change.json
    1v1-aborted-disconnect.log  ← hand-edited synthetic log (no real example exists yet)
    1v1-aborted-disconnect.json
    1v1-no-supstats2.log        ← hand-edited: vanilla kill lines only (strip supstats2 lines from real log)
    1v1-no-supstats2.json
    1v1-new-matchend.log        ← log produced after plugin fix (loser field present); create once server runs new plugin
    1v1-new-matchend.json
    1v1-unicode-names.log       ← already present in mge_260428051241f6e8.log (player "pasaisviesisз marts no kadaફ")
    1v1-unicode-names.json      ← this may be folded into 1v1-soldier rather than a separate fixture
  parse.test.ts                 ← unit tests: one per fixture pair
  server.test.ts                ← HTTP integration tests
```

## Notes on the example log corpus

Observations from `docs/example-logs/` that affect parser development:

- All 30 logs use the **old** `mge_match_end` format (no `loser` field). The loser must be inferred for all existing real logs.
- All 8 incomplete logs are aborted with `reason "map_change"`. No `player_disconnect` example exists yet — that fixture must be synthesized by hand.
- Arena names contain bracketed suffixes: `[1v1 MGE]`, `[1v1 AMOD]`, `[AC]`. These are display annotations, not gamemode values. The parser stores the full arena name string as-is.
- Arenas labelled `AMOD` in the display name report `gamemode "mge"` — not `"ammomod"`. This is correct: `ammomod` in MGEMod is its own distinct gamemode flag. The AMOD arenas on this server happen to use the standard `mge` gamemode. The parser does not infer gamemode from the arena display name.
- `fraglimit "0"` appears in every log. This means the arena has no frag limit configured (unlimited). The parser stores `0` as-is — it is not null or undefined.
- The Unicode fixture is already covered by `mge_260428051241f6e8.log` (player name contains Cyrillic, Latvian diacritics, and Gujarati script). A separate unicode-names fixture is unnecessary — the primary `1v1-soldier` fixture already exercises this.
