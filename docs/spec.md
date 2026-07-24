# MGE Logs Parser — Specification

**Status:** Draft  
**Created:** 2026-04-28

---

## 1. Overview

The MGE Logs Parser is a standalone HTTP microservice that accepts a raw TF2 log file (as produced by the `mge_logs` SourceMod plugin) and returns a structured JSON representation of the match.

It is intentionally decoupled from the mge.tf website backend so that:

- The parser can be upgraded and redeployed without touching the website.
- Historical raw logs can be re-POSTed against a new parser version to update stored stats.
- The parser can be tested in complete isolation — input is text, output is JSON, no external dependencies.
- Any future system (e.g. a `mge_match` competitive plugin) can consume it independently.

The parser performs **no database writes** and has **no external dependencies at runtime**. It is a pure function: the same input always produces the same output.

---

## 2. Technology

- **Runtime:** Bun (latest stable)
- **Language:** TypeScript (strict mode) — executed natively by Bun, no build step required
- **HTTP framework:** Fastify
- **Worker thread pool:** [tinypool](https://github.com/tinylibs/tinypool)
- **Test runner:** Bun built-in (`bun test`)
- **No ORM, no DB client, no queue dependency**

> **Why tinypool over piscina?** piscina has known stability issues under Bun's TypeScript runtime (segfaults on worker errors). tinypool is API-compatible, Bun-tested, and 95% smaller (38 KB vs 800 KB). The implementation difference is only the import name.

## 3. Project Structure

```
src/
  types.ts      ← all shared TypeScript interfaces (ParsedMatch, PlayerRecord, etc.)
  parser.ts     ← pure synchronous parse function; no runtime imports; no side effects
  worker.ts     ← worker thread entry point; imports parser.ts; handles parentPort messaging
  server.ts     ← Fastify HTTP server; creates tinypool pool over worker.ts; routes requests
```

### Design constraint: parser.ts must remain pure

`parser.ts` exports a single function:

```typescript
export function parse(logText: string): ParsedMatch
```

It must have **no side effects, no global state, and no built-in runtime imports** (no `fs`, no `path`, no `process`). This constraint makes it:

- Trivially unit-testable: import and call directly with `bun test`
- Safe to run in worker threads: no shared state to corrupt across concurrent calls
- Easy to move to other runtimes in the future if needed

### Concurrency model

The parse function is synchronous and CPU-bound. Running it directly in the Fastify request handler would block the event loop during parsing, serialising all concurrent requests onto one thread.

Instead, the HTTP handler dispatches each parse call to a `tinypool` worker thread pool:

```
Main thread (event loop — always free):
  request 1 → pool.run(logText) ──→ Worker thread 1: parse() → result
  request 2 → pool.run(logText) ──→ Worker thread 2: parse() → result
  request 3 → pool.run(logText) ──→ Worker thread 3: parse() → result
```

The pool size defaults to `os.availableParallelism()`, so it automatically uses all available CPU cores — no configuration needed. On a 2-vCPU host, 2 parses run in parallel. On a 4-vCPU host, 4. Scaling up the host instance size directly translates to more concurrency.

### Scaling

For higher load beyond a single instance, run multiple instances behind a load balancer. Because the service is stateless (no DB, no shared memory), this requires no coordination. The primary scaling lever is horizontal: more instances. The worker thread pool is the secondary lever: more cores per instance.

---

## 4. HTTP API

### 4.1 Parse endpoint

```
POST /parse
Content-Type: text/plain
Body: <raw log file content>

→ 200 OK
Content-Type: application/json
Body: ParsedMatch (see §6)

→ 400 Bad Request
Content-Type: application/json
Body: { "error": "<reason>" }

→ 500 Internal Server Error
Content-Type: application/json
Body: { "error": "<reason>" }
```

The request body is the raw log file text. No multipart, no base64, no JSON wrapper.  
Maximum accepted body size: **2 MB**. Requests exceeding this are rejected with 413.

### 4.2 Health check

```
GET /health
→ 200 OK
Body: { "ok": true }
```

### 4.3 Error conditions

| Condition | HTTP status | `error` value |
|---|---|---|
| Body is empty | 400 | `"empty log"` |
| No `meta_data` line found | 400 | `"missing meta_data"` |
| Body exceeds 2 MB | 413 | `"log too large"` |
| Unhandled exception during parse | 500 | `"internal parse error"` |

Unknown or unrecognised log lines are silently skipped — they do not cause errors.

---

## 5. Input Format

### 5.1 Line structure

Every line in a TF2 log file follows:

```
L mm/dd/yyyy - HH:MM:SS: <message>
```

The parser extracts the timestamp from the prefix and then classifies the `<message>` portion by pattern matching.

### 5.2 Player token

Many log lines contain one or two player tokens:

```
"Name<uid><[U:1:XXXXXXX]><Team>"
```

- `Name` — display name at time of event (may contain special characters, spaces, quotes escaped as `\"`)
- `uid` — server-local user ID (integer, not globally unique)
- `[U:1:XXXXXXX]` — Steam3 ID format, used as the canonical player identifier throughout
- `Team` — `"Red"` or `"Blue"` (or `"Unassigned"` / `"Spectator"` in edge cases)

### 5.3 MGE-specific line types

These lines are emitted by `mge_logs` and are not part of the standard TF2 log format.

#### `meta_data`
Always the first log line in a file. Present exactly once.

```
World triggered "meta_data" (matchid "<id>") (map "<map>") (arena "<name>") (gamemode "<mode>") (fraglimit "<n>")
```

Fields: `matchid`, `map`, `arena`, `gamemode`, `fraglimit`  
Gamemodes: `mge` | `bball` | `koth` | `ammomod` | `midair` | `endif` | `ultiduo`

#### `changed role to`
Emitted once per player at session start. Establishes player identity and starting class.

```
"Name<uid><[U:1:X]><Team>" changed role to "<class>"
```

Classes: `scout` | `soldier` | `demoman` | `medic` | `heavyweapons` | `pyro` | `sniper` | `spy` | `engineer`

#### `mge_match_end` (1v1)
```
World triggered "mge_match_end" (winner "<[U:1:X]>") (loser "<[U:1:Y]>") (winner_score "<n>") (loser_score "<n>")
```

#### `mge_match_end` (2v2)
```
World triggered "mge_match_end" (winning_team "<Red|Blue>") (winning_score "<n>") (losing_score "<n>") (winner_p1 "<[U:1:X]>") (winner_p2 "<[U:1:Y]>") (loser_p1 "<[U:1:Z]>") (loser_p2 "<[U:1:W]>")
```

#### `mge_elo_delta`
Emitted once per player after match end. May be absent if the server has no ELO database.

```
World triggered "mge_elo_delta" (player "<[U:1:X]>") (old_elo "<n>") (new_elo "<n>")
```

#### `mge_match_aborted`
Present only in `_incomplete` log files. Always the last line before EOF.

```
World triggered "mge_match_aborted" (reason "<player_disconnect|map_change|plugin_unload>")
```

### 5.4 Standard TF2 line types (subset used)

#### Kill
```
"Attacker<uid><[U:1:X]><Team>" killed "Victim<uid><[U:1:Y]><Team>" with "<weapon>"
```

Optional suffixes appended by supstats2:
```
(customkill "headshot")
(airshot "1") (height "<n>")
```

#### Damage (supstats2)
```
"Attacker<uid><[U:1:X]><Team>" triggered "damage" against "Victim<uid><[U:1:Y]><Team>" (damage "<n>") (weapon "<weapon>")
```

Optional key-value pairs that may appear (in any order after `weapon`):
- `(realdamage "<n>")` — actual HP removed after damage resistance/rounding; absent on some hits
- `(headshot "<0|1>")` — present when supstats2 detects a headshot
- `(airshot "<0|1>") (height "<n>")` — present when the hit is an airshot

#### Shot fired / hit (supstats2 accuracy tracking)
```
"Player<uid><[U:1:X]><Team>" triggered "shot_fired" (weapon "<weapon>")
"Player<uid><[U:1:X]><Team>" triggered "shot_hit" (weapon "<weapon>")
```

#### Airshot (supstats2)
```
"Attacker<uid><[U:1:X]><Team>" triggered "airshot" against "Victim<uid><[U:1:Y]><Team>" (height "<n>")
```

#### Spawn (vanilla TF2 engine)
```
"Player<uid><[U:1:X]><Team>" spawned as "<class>"
```

Tracks class changes during a match. A player may spawn multiple times with different classes.

#### Chat
```
"Player<uid><[U:1:X]><Team>" say "<message>"
"Player<uid><[U:1:X]><Team>" say_team "<message>"
```

#### Medic stats (medicstats — relevant for Ultiduo)
```
"Player<uid><[U:1:X]><Team>" triggered "chargedeployed" (medigun "<name>")
"Player<uid><[U:1:X]><Team>" triggered "chargeready"
"Player<uid><[U:1:X]><Team>" triggered "chargeended" (duration "<n.nn>")
"Player<uid><[U:1:X]><Team>" triggered "medic_death_ex" (uberpct "<n>")
"Player<uid><[U:1:X]><Team>" triggered "first_heal_after_spawn" (time "<n.nn>")
"Player<uid><[U:1:X]><Team>" triggered "lost_uber_advantage" (time "<n.nn>")
```

#### BBall / KOTH objectives
```
"Player<uid><[U:1:X]><Team>" triggered "flagintel" (scoring "<1>")  ← BBall goal
Team "<Red|Blue>" triggered "pointcaptured" ...                      ← KOTH cap
```

---

## 6. Parser Rules

### 6.1 Pass structure

The parser makes a **single sequential pass** over all lines. There is no lookahead.

```
for each line:
  1. Strip the "L mm/dd/yyyy - HH:MM:SS: " prefix → extract timestamp + message
  2. Classify the message by pattern matching (ordered, first match wins)
  3. Dispatch to the appropriate handler
  4. Accumulate into ParseState
after all lines:
  5. Compute derived stats from accumulated ParseState
  6. Assemble and return ParsedMatch
```

### 6.2 Classification order

Lines are classified in this order to avoid ambiguity:

1. `meta_data` — exact string match
2. `mge_match_end` — exact string match
3. `mge_elo_delta` — exact string match
4. `mge_match_aborted` — exact string match
5. `changed role to` — player token + literal
6. `killed` — player token + `killed` + player token
7. `damage` — player token + `triggered "damage"`
8. `shot_fired` — player token + `triggered "shot_fired"`
9. `shot_hit` — player token + `triggered "shot_hit"`
10. `airshot` — player token + `triggered "airshot"`
11. `spawned as` — player token + literal `spawned as "`
12. `chargedeployed` — player token + `triggered "chargedeployed"`
13. `chargeready` — player token + `triggered "chargeready"`
14. `chargeended` — player token + `triggered "chargeended"`
15. `medic_death_ex` — player token + `triggered "medic_death_ex"`
16. `say` / `say_team` — player token + `say`
17. Everything else — discard silently

### 6.3 Key value extraction

Many log lines contain parenthesised key-value pairs: `(key "value")`.  
Extract with the pattern: `/\((\w+)\s+"([^"]*)"\)/g`

### 6.4 Player token extraction

Extract the Steam3 ID from a player token with: `/\[U:1:\d+\]/`

Player name and team should also be extracted where relevant (e.g. `changed role to`, first kill line per player to populate display names).

### 6.5 Timestamp parsing

Format: `mm/dd/yyyy - HH:MM:SS`  
Parse as UTC. The match duration is `endedAt - startedAt` where:
- `startedAt` = timestamp of the first line in the file
- `endedAt` = timestamp of the `mge_match_end` line (or last line if aborted)

### 6.6 Identity resolution

Players are identified throughout by Steam3 ID. The `changed role to` lines at the top of the file establish the initial identity mapping (Steam3 ID → name, team, starting class). Subsequent `spawned_as` lines update the player's current class but do not change identity.

If a kill or damage line contains a Steam3 ID not seen in any `changed role to` line, create a minimal player record from the player token and emit a warning in the parse log (not an error — the match result is still valid).

---

## 7. Output Schema

```typescript
interface ParsedMatch {
  meta: MatchMeta;
  players: PlayerRecord[];
  events: MatchEvent[];
  chat: ChatMessage[];
}

interface MatchMeta {
  matchId: string;
  map: string;
  arena: string;
  gamemode: 'mge' | 'bball' | 'koth' | 'ammomod' | 'midair' | 'endif' | 'ultiduo';
  fragLimit: number;
  format: '1v1' | '2v2';
  startedAt: string;        // ISO 8601 UTC
  endedAt: string;          // ISO 8601 UTC
  durationSeconds: number;
  aborted: boolean;
  abortReason: string | null;  // "player_disconnect" | "map_change" | "plugin_unload" | null
}

interface PlayerRecord {
  steamId: string;          // "[U:1:X]" format
  name: string;             // display name at match start
  team: 'Red' | 'Blue';
  startClass: string;
  won: boolean;
  score: number;            // kills for mge/ammomod/midair/endif, goals for bball, etc.
  elo: EloRecord | null;
  stats: PlayerStats;
}

interface EloRecord {
  before: number;
  after: number;
  delta: number;
}

interface PlayerStats {
  kills: number;
  deaths: number;
  damageDone: number;
  damageReceived: number;
  dpm: number;              // damageDone / (durationSeconds / 60), rounded to 1 decimal
  shotsFired: number;
  shotsHit: number;
  accuracy: number | null;  // (shotsHit / shotsFired) * 100, null if shotsFired === 0
  airshots: number;         // from "airshot" triggered lines
  headshotKills: number;
  weaponBreakdown: Record<string, WeaponStats>;
  // Medic stats (null unless gamemode is "ultiduo" and medicstats is present)
  medicStats: MedicStats | null;
}

interface WeaponStats {
  kills: number;
  damage: number;
  shotsFired: number;
  shotsHit: number;
}

interface MedicStats {
  chargesDeployed: number;
  chargesDropped: number;   // medic_death_ex lines where uberpct > 0
  avgChargeDuration: number | null;
  medigun: string | null;   // last medigun used
}

// Events are ordered chronologically.
type MatchEvent = KillEvent | DamageEvent | AirshotEvent;

interface KillEvent {
  type: 'kill';
  timestamp: string;        // ISO 8601 UTC
  attackerSteamId: string;
  victimSteamId: string;
  weapon: string;
  headshot: boolean;
  airshot: boolean;
}

interface DamageEvent {
  type: 'damage';
  timestamp: string;
  attackerSteamId: string;
  victimSteamId: string;
  damage: number;
  realDamage: number;       // 0 if supstats2 not present
  weapon: string;
  headshot: boolean;
  airshot: boolean;
}

interface AirshotEvent {
  type: 'airshot';
  timestamp: string;
  attackerSteamId: string;
  victimSteamId: string;
  height: number;
}

interface ChatMessage {
  timestamp: string;
  steamId: string;
  scope: 'all' | 'team';
  message: string;
}
```

### 7.1 Fields present regardless of supstats2

If supstats2 is not installed on the server, the log will contain only vanilla TF2 kill lines. In that case:
- `damage`, `accuracy`, `shotsFired`, `shotsHit` are all `0`
- `airshots` is `0`
- `realDamage` on DamageEvents is `0`
- `events` contains only `KillEvent` entries

The output schema is identical — consumers always receive the same shape.

### 7.2 DPM formula

```
dpm = damageDone / (durationSeconds / 60)
```

Uses the full match duration (`endedAt - startedAt`), not just time alive.

### 7.3 Accuracy formula

```
accuracy = (shotsHit / shotsFired) * 100
```

Null if `shotsFired === 0`. Note: supstats2 filters out rocket-jump self-shots from `shot_fired`, so this reflects accuracy against opponents only.

---

## 8. Edge Cases

| Scenario | Handling |
|---|---|
| Aborted match (`_incomplete` suffix) | Parse normally; `meta.aborted = true`, `meta.abortReason` set from `mge_match_aborted` line |
| No `meta_data` line | Return 400 `"missing meta_data"` |
| `mge_elo_delta` absent | `elo: null` for affected players |
| Player in kill line not in `changed role to` | Create minimal player record from token; continue |
| `shot_fired` / `shot_hit` present but no `damage` lines | Accuracy computed; DPM remains 0 |
| Duplicate `meta_data` lines | Use the first one; ignore subsequent |
| Timestamps that go backwards (clock correction) | Use wall-clock order of lines, not timestamp order |
| 2v2 match with no medicstats lines | `medicStats: null` for all players |
| Player name containing `"` characters | Already escaped in the log as `\"` — unescape on extraction |
| Line longer than 2048 characters | Skip with a warning; do not abort parse |

---

## 9. Testing Strategy

Tests use **golden files**: pairs of `<name>.log` (input) and `<name>.json` (expected output) stored in `tests/fixtures/`.

```
tests/
  fixtures/
    1v1-basic.log           ← real log from live server
    1v1-basic.json          ← expected ParsedMatch output
    1v1-no-supstats2.log    ← vanilla kill lines only
    1v1-no-supstats2.json
    1v1-aborted.log         ← _incomplete log with mge_match_aborted
    1v1-aborted.json
    2v2-ultiduo.log
    2v2-ultiduo.json
    bball.log
    bball.json
    midair.log
    midair.json
  parse.test.ts             ← one test per fixture pair
```

Each test: parse the `.log` file → deep-equal assert against the `.json` file.

New edge cases discovered in production (malformed lines, unusual player names, unexpected log patterns) are added as new fixture pairs before fixing the parser. This is the spec-driven part: the fixture files are the spec.

---

## 10. What the Parser Does Not Do

- **No database writes.** The caller (mge.tf backend) decides what to persist.
- **No ELO computation.** ELO deltas are read from the log as recorded by the plugin; the parser does not calculate them.
- **No match validation.** If kill counts don't match the declared winner score, the parser does not flag it.
- **No authentication.** The service is internal; callers on the same network do not need API keys. If exposed externally, a reverse proxy handles auth.
- **No async queue.** The HTTP layer dispatches each parse call to a worker thread pool (piscina); the parse function itself is synchronous. The caller handles upstream queueing if needed.
- **No log storage.** The parser receives the log text and returns JSON. It does not write anything to disk.
