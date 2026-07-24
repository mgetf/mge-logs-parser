import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "../src/parser.ts";
import type { ParsedMatch, KillEvent, DamageEvent } from "../src/types.ts";

function fixture(name: string): string {
  return join(import.meta.dir, "fixtures", name);
}

describe("parse", () => {
  let actual: ParsedMatch;
  let expected: ParsedMatch;

  beforeAll(() => {
    const logText = readFileSync(fixture("1v1-soldier.log"), "utf8");
    expected = JSON.parse(
      readFileSync(fixture("1v1-soldier.json"), "utf8")
    ) as ParsedMatch;
    actual = parse(logText);
  });

  it("1v1-soldier: matches golden fixture", () => {
    expect(actual).toEqual(expected);
  });

  describe("1v1-soldier: pinned meta values", () => {
    it("matchId", () => expect(actual.meta.matchId).toBe("260428051241f6e8"));
    it("map", () => expect(actual.meta.map).toBe("mge_triumph_beta7_rc1"));
    it("arena", () => expect(actual.meta.arena).toBe("Badlands Middle 1 [1v1 MGE]"));
    it("gamemode", () => expect(actual.meta.gamemode).toBe("mge"));
    it("fragLimit", () => expect(actual.meta.fragLimit).toBe(0));
    it("format", () => expect(actual.meta.format).toBe("1v1"));
    it("startedAt", () => expect(actual.meta.startedAt).toBe("2026-04-28T05:12:41Z"));
    it("endedAt", () => expect(actual.meta.endedAt).toBe("2026-04-28T05:15:29Z"));
    it("durationSeconds", () => expect(actual.meta.durationSeconds).toBe(168));
    it("aborted", () => expect(actual.meta.aborted).toBe(false));
    it("abortReason", () => expect(actual.meta.abortReason).toBeNull());
  });

  describe("1v1-soldier: pinned player values", () => {
    it("player count", () => expect(actual.players).toHaveLength(2));

    it("Red player identity", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.name).toBe("SoldierBoy");
      expect(p?.team).toBe("Red");
      expect(p?.startClass).toBe("soldier");
    });

    it("Blue player identity", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.name).toBe("QuickScout");
      expect(p?.team).toBe("Blue");
      expect(p?.startClass).toBe("soldier");
    });

    it("winner and score", () => {
      const winner = actual.players.find((p) => p.won);
      expect(winner?.steamId).toBe("[U:1:900000011]");
      expect(winner?.score).toBe(20);
    });

    it("loser and score", () => {
      const loser = actual.players.find((p) => !p.won);
      expect(loser?.steamId).toBe("[U:1:900000012]");
      expect(loser?.score).toBe(5);
    });

    it("Red player ELO unchanged", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.elo).toEqual({ before: 2722, after: 2722, delta: 0 });
    });

    it("Blue player ELO unchanged", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.elo).toEqual({ before: 2131, after: 2131, delta: 0 });
    });
  });

  describe("1v1-soldier: pinned kill values", () => {
    it("25 kill events total", () => {
      const kills = actual.events.filter((e): e is KillEvent => e.type === "kill");
      expect(kills).toHaveLength(25);
    });

    it("SoldierBoy has 20 kills and 5 deaths", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.stats.kills).toBe(20);
      expect(p?.stats.deaths).toBe(5);
    });

    it("QuickScout has 5 kills and 20 deaths", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.stats.kills).toBe(5);
      expect(p?.stats.deaths).toBe(20);
    });

    it("no headshot kills", () => {
      const kills = actual.events.filter((e): e is KillEvent => e.type === "kill");
      expect(kills.every((k) => !k.headshot)).toBe(true);
    });

    it("SoldierBoy kill weapon breakdown", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.stats.weaponBreakdown["world"]?.kills).toBe(3);
      expect(p?.stats.weaponBreakdown["quake_rl"]?.kills).toBe(8);
      expect(p?.stats.weaponBreakdown["shotgun_soldier"]?.kills).toBe(9);
    });

    it("QuickScout kill weapon breakdown", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.stats.weaponBreakdown["shotgun_soldier"]?.kills).toBe(5);
    });

    it("first kill event is correct", () => {
      const first = actual.events.find((e): e is KillEvent => e.type === "kill");
      expect(first?.attackerSteamId).toBe("[U:1:900000011]");
      expect(first?.victimSteamId).toBe("[U:1:900000012]");
      expect(first?.weapon).toBe("world");
      expect(first?.timestamp).toBe("2026-04-28T05:12:49Z");
    });
  });

  describe("1v1-soldier: pinned damage values", () => {
    it("135 damage events total", () => {
      const dmg = actual.events.filter((e): e is DamageEvent => e.type === "damage");
      expect(dmg).toHaveLength(135);
    });

    it("SoldierBoy damage done and received", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.stats.damageDone).toBe(4308);
      expect(p?.stats.damageReceived).toBe(3237);
    });

    it("QuickScout damage done and received", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.stats.damageDone).toBe(3237);
      expect(p?.stats.damageReceived).toBe(4308);
    });

    it("SoldierBoy DPM", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.stats.dpm).toBe(1538.6);
    });

    it("QuickScout DPM", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.stats.dpm).toBe(1156.1);
    });

    it("SoldierBoy accuracy (59%)", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.stats.shotsFired).toBe(122);
      expect(p?.stats.shotsHit).toBe(72);
      expect(p?.stats.accuracy).toBe(59);
    });

    it("QuickScout accuracy (53.8%)", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.stats.shotsFired).toBe(117);
      expect(p?.stats.shotsHit).toBe(63);
      expect(p?.stats.accuracy).toBe(53.8);
    });

    it("damage event with realdamage=0 when absent", () => {
      const dmg = actual.events.filter((e): e is DamageEvent => e.type === "damage");
      const withoutReal = dmg.find((e) => e.realDamage === 0);
      expect(withoutReal).toBeDefined();
    });

    it("damage event with realdamage when present", () => {
      const dmg = actual.events.filter((e): e is DamageEvent => e.type === "damage");
      const withReal = dmg.find((e) => e.realDamage > 0);
      expect(withReal).toBeDefined();
    });

    it("damage events with airshot flag", () => {
      const dmg = actual.events.filter((e): e is DamageEvent => e.type === "damage");
      const airshotDmg = dmg.filter((e) => e.airshot);
      expect(airshotDmg).toHaveLength(8);
    });

    it("SoldierBoy weapon damage breakdown", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.stats.weaponBreakdown["quake_rl"]?.damage).toBe(3159);
      expect(p?.stats.weaponBreakdown["shotgun_soldier"]?.damage).toBe(1031);
      expect(p?.stats.weaponBreakdown["tf_projectile_rocket"]?.damage).toBe(118);
    });
  });

  describe("1v1-soldier: pinned airshot and weapon breakdown values", () => {
    it("SoldierBoy has 6 airshots", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      expect(p?.stats.airshots).toBe(6);
    });

    it("QuickScout has 2 airshots", () => {
      const p = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(p?.stats.airshots).toBe(2);
    });

    it("no headshot kills for either player", () => {
      for (const p of actual.players) {
        expect(p.stats.headshotKills).toBe(0);
      }
    });

    it("SoldierBoy full weapon breakdown", () => {
      const wb = actual.players.find((p) => p.steamId === "[U:1:900000011]")?.stats.weaponBreakdown;
      expect(wb?.["quake_rl"]).toEqual({ kills: 8, damage: 3159, shotsFired: 88, shotsHit: 43 });
      expect(wb?.["shotgun_soldier"]).toEqual({ kills: 9, damage: 1031, shotsFired: 31, shotsHit: 27 });
      expect(wb?.["tf_projectile_rocket"]).toEqual({ kills: 0, damage: 118, shotsFired: 3, shotsHit: 2 });
      expect(wb?.["world"]).toEqual({ kills: 3, damage: 0, shotsFired: 0, shotsHit: 0 });
    });

    it("QuickScout full weapon breakdown", () => {
      const wb = actual.players.find((p) => p.steamId === "[U:1:900000012]")?.stats.weaponBreakdown;
      expect(wb?.["quake_rl"]).toEqual({ kills: 0, damage: 2675, shotsFired: 86, shotsHit: 41 });
      expect(wb?.["shotgun_soldier"]).toEqual({ kills: 5, damage: 562, shotsFired: 31, shotsHit: 22 });
    });
  });

  describe("1v1-soldier: chat", () => {
    it("no chat messages in fixture log", () => {
      expect(actual.chat).toHaveLength(0);
    });
  });

  describe("chat parsing (synthetic)", () => {
    const STUB_META = 'L 04/28/2026 - 05:12:41: World triggered "meta_data" (matchid "test") (map "cp_test") (arena "Arena") (gamemode "mge") (fraglimit "20")\n';
    const STUB_ROLE = 'L 04/28/2026 - 05:12:41: "Player<1><[U:1:1]><Red>" changed role to "soldier"\n';

    it("captures say (all-chat) messages", () => {
      const log =
        STUB_META +
        STUB_ROLE +
        'L 04/28/2026 - 05:12:50: "Player<1><[U:1:1]><Red>" say "gg"\n' +
        'L 04/28/2026 - 05:12:51: World triggered "mge_match_end" (winner "[U:1:1]") (winner_score "20") (loser_score "0")\n';
      const result = parse(log);
      expect(result.chat).toHaveLength(1);
      expect(result.chat[0]).toEqual({
        timestamp: "2026-04-28T05:12:50Z",
        steamId: "[U:1:1]",
        scope: "all",
        message: "gg",
      });
    });

    it("captures say_team messages with team scope", () => {
      const log =
        STUB_META +
        STUB_ROLE +
        'L 04/28/2026 - 05:12:50: "Player<1><[U:1:1]><Red>" say_team "nice shot!"\n' +
        'L 04/28/2026 - 05:12:51: World triggered "mge_match_end" (winner "[U:1:1]") (winner_score "20") (loser_score "0")\n';
      const result = parse(log);
      expect(result.chat).toHaveLength(1);
      expect(result.chat[0]?.scope).toBe("team");
      expect(result.chat[0]?.message).toBe("nice shot!");
    });

    it("multiple chat messages are ordered chronologically", () => {
      const log =
        STUB_META +
        STUB_ROLE +
        'L 04/28/2026 - 05:12:45: "Player<1><[U:1:1]><Red>" say "first"\n' +
        'L 04/28/2026 - 05:12:50: "Player<1><[U:1:1]><Red>" say "second"\n' +
        'L 04/28/2026 - 05:12:51: World triggered "mge_match_end" (winner "[U:1:1]") (winner_score "20") (loser_score "0")\n';
      const result = parse(log);
      expect(result.chat).toHaveLength(2);
      expect(result.chat[0]?.message).toBe("first");
      expect(result.chat[1]?.message).toBe("second");
    });
  });

  // ── Edge-case fixture: aborted by map change ──────────────────────────────

  describe("1v1-aborted-map-change", () => {
    let actual: ParsedMatch;
    let expected: ParsedMatch;

    beforeAll(() => {
      const logText = readFileSync(fixture("1v1-aborted-map-change.log"), "utf8");
      expected = JSON.parse(readFileSync(fixture("1v1-aborted-map-change.json"), "utf8")) as ParsedMatch;
      actual = parse(logText);
    });

    it("matches golden fixture", () => {
      expect(actual).toEqual(expected);
    });

    it("meta.aborted is true with reason map_change", () => {
      expect(actual.meta.aborted).toBe(true);
      expect(actual.meta.abortReason).toBe("map_change");
    });

    it("meta.matchId and fragLimit are correct", () => {
      expect(actual.meta.matchId).toBe("260427233226c477");
      expect(actual.meta.fragLimit).toBe(0);
    });

    it("both players have score=0 with no elo", () => {
      for (const p of actual.players) {
        expect(p.score).toBe(0);
        expect(p.elo).toBeNull();
      }
    });

    it("no events", () => {
      expect(actual.events).toHaveLength(0);
    });

    it("has two chat messages from the same player", () => {
      expect(actual.chat).toHaveLength(2);
      expect(actual.chat[0]?.steamId).toBe("[U:1:900000008]");
      expect(actual.chat[0]?.message).toBe("!add");
      expect(actual.chat[1]?.message).toBe("gg");
    });
  });

  // ── Edge-case fixture: aborted by player disconnect ───────────────────────

  describe("1v1-aborted-disconnect", () => {
    let actual: ParsedMatch;
    let expected: ParsedMatch;

    beforeAll(() => {
      const logText = readFileSync(fixture("1v1-aborted-disconnect.log"), "utf8");
      expected = JSON.parse(readFileSync(fixture("1v1-aborted-disconnect.json"), "utf8")) as ParsedMatch;
      actual = parse(logText);
    });

    it("matches golden fixture", () => {
      expect(actual).toEqual(expected);
    });

    it("meta.aborted is true with reason player_disconnect", () => {
      expect(actual.meta.aborted).toBe(true);
      expect(actual.meta.abortReason).toBe("player_disconnect");
    });

    it("partial kill stats are preserved", () => {
      const playerA = actual.players.find((p) => p.steamId === "[U:1:900000014]");
      const playerB = actual.players.find((p) => p.steamId === "[U:1:900000015]");
      expect(playerA?.stats.kills).toBe(1);
      expect(playerA?.stats.deaths).toBe(0);
      expect(playerB?.stats.kills).toBe(0);
      expect(playerB?.stats.deaths).toBe(1);
    });

    it("1 kill event exists", () => {
      const kills = actual.events.filter((e) => e.type === "kill") as KillEvent[];
      expect(kills).toHaveLength(1);
      expect(kills[0]?.weapon).toBe("tf_projectile_rocket");
    });

    it("no elo for either player", () => {
      for (const p of actual.players) expect(p.elo).toBeNull();
    });
  });

  // ── Edge-case fixture: no supstats2 lines ─────────────────────────────────

  describe("1v1-no-supstats2", () => {
    let actual: ParsedMatch;
    let expected: ParsedMatch;

    beforeAll(() => {
      const logText = readFileSync(fixture("1v1-no-supstats2.log"), "utf8");
      expected = JSON.parse(readFileSync(fixture("1v1-no-supstats2.json"), "utf8")) as ParsedMatch;
      actual = parse(logText);
    });

    it("matches golden fixture", () => {
      expect(actual).toEqual(expected);
    });

    it("only KillEvents in events array", () => {
      expect(actual.events.length).toBeGreaterThan(0);
      for (const e of actual.events) expect(e.type).toBe("kill");
    });

    it("same kill counts as 1v1-soldier", () => {
      const soldierBoy = actual.players.find((p) => p.steamId === "[U:1:900000011]");
      const quickScout = actual.players.find((p) => p.steamId === "[U:1:900000012]");
      expect(soldierBoy?.stats.kills).toBe(20);
      expect(soldierBoy?.stats.deaths).toBe(5);
      expect(quickScout?.stats.kills).toBe(5);
      expect(quickScout?.stats.deaths).toBe(20);
    });

    it("all damage stats are zero with null accuracy", () => {
      for (const p of actual.players) {
        expect(p.stats.damageDone).toBe(0);
        expect(p.stats.damageReceived).toBe(0);
        expect(p.stats.dpm).toBe(0);
        expect(p.stats.shotsFired).toBe(0);
        expect(p.stats.shotsHit).toBe(0);
        expect(p.stats.accuracy).toBeNull();
        expect(p.stats.airshots).toBe(0);
      }
    });

    it("weapon breakdown has kills but no damage or shot counts", () => {
      const soldierBoy = actual.players.find((p) => p.steamId === "[U:1:900000011]")!;
      const wb = soldierBoy.stats.weaponBreakdown;
      for (const stats of Object.values(wb)) {
        expect(stats.damage).toBe(0);
        expect(stats.shotsFired).toBe(0);
        expect(stats.shotsHit).toBe(0);
      }
      expect(wb["quake_rl"]?.kills).toBeGreaterThan(0);
    });
  });

  // ── Edge-case fixture: new mge_match_end with explicit loser field ────────

  describe("1v1-new-matchend", () => {
    let actual: ParsedMatch;
    let expected: ParsedMatch;

    beforeAll(() => {
      const logText = readFileSync(fixture("1v1-new-matchend.log"), "utf8");
      expected = JSON.parse(readFileSync(fixture("1v1-new-matchend.json"), "utf8")) as ParsedMatch;
      actual = parse(logText);
    });

    it("matches golden fixture", () => {
      expect(actual).toEqual(expected);
    });

    it("winner and loser are assigned via explicit loser field", () => {
      const alpha = actual.players.find((p) => p.steamId === "[U:1:900000016]");
      const beta = actual.players.find((p) => p.steamId === "[U:1:900000017]");
      expect(alpha?.won).toBe(true);
      expect(alpha?.score).toBe(10);
      expect(beta?.won).toBe(false);
      expect(beta?.score).toBe(3);
    });

    it("elo delta is recorded for both players", () => {
      const alpha = actual.players.find((p) => p.steamId === "[U:1:900000016]");
      const beta = actual.players.find((p) => p.steamId === "[U:1:900000017]");
      expect(alpha?.elo).toEqual({ before: 1500, after: 1516, delta: 16 });
      expect(beta?.elo).toEqual({ before: 1450, after: 1434, delta: -16 });
    });
  });

  // ── Hardening: edge-case assertions (no new fixture) ─────────────────────

  describe("hardening", () => {
    it("unknown line types are silently skipped", () => {
      const log =
        'L 04/28/2026 - 05:12:41: World triggered "meta_data" (matchid "abc") (map "m") (arena "a") (gamemode "mge") (fraglimit "5")\n' +
        'L 04/28/2026 - 05:12:41: "P<1><[U:1:1]><Red>" changed role to "soldier"\n' +
        'L 04/28/2026 - 05:12:41: "P<1><[U:1:1]><Red>" TOTALLY_UNKNOWN_EVENT "whatever"\n' +
        'L 04/28/2026 - 05:12:42: World triggered "mge_match_end" (winner "[U:1:1]") (winner_score "5") (loser_score "0")\n';
      expect(() => parse(log)).not.toThrow();
      const result = parse(log);
      expect(result.meta.matchId).toBe("abc");
    });

    it("parser does not throw when mge_elo_delta is absent", () => {
      const log =
        'L 04/28/2026 - 05:12:41: World triggered "meta_data" (matchid "noelo") (map "m") (arena "a") (gamemode "mge") (fraglimit "5")\n' +
        'L 04/28/2026 - 05:12:41: "P<1><[U:1:1]><Red>" changed role to "soldier"\n' +
        'L 04/28/2026 - 05:12:42: World triggered "mge_match_end" (winner "[U:1:1]") (winner_score "5") (loser_score "0")\n';
      const result = parse(log);
      expect(result.players[0]?.elo).toBeNull();
    });

    it("fraglimit 0 is stored as 0, not null or NaN", () => {
      const log =
        'L 04/28/2026 - 05:12:41: World triggered "meta_data" (matchid "fl0") (map "m") (arena "a") (gamemode "mge") (fraglimit "0")\n' +
        'L 04/28/2026 - 05:12:41: "P<1><[U:1:1]><Red>" changed role to "soldier"\n' +
        'L 04/28/2026 - 05:12:42: World triggered "mge_match_end" (winner "[U:1:1]") (winner_score "0") (loser_score "0")\n';
      const result = parse(log);
      expect(result.meta.fragLimit).toBe(0);
      expect(Number.isNaN(result.meta.fragLimit)).toBe(false);
    });
  });
});
